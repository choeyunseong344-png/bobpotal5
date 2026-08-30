const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs'); // Render 호환성 강화를 위해 bcryptjs로 변경
const cors = require('cors');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const JWT_SECRET = 'SORABOL_BOBPORTAL_SECRET_KEY';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 임시 DB 데이터베이스 (실제 DB 연결시 Supabase/PostgreSQL로 연동)
let db = {
    users: [],
    trades: [],
    questions: [],
    answers: []
};

// --- [인증 미들웨어] ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: '로그인이 필요합니다.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: '유효하지 않은 토큰입니다.' });
        req.user = user;
        next();
    });
};

// --- [REST API 엔드포인트] ---

// 1. 회원가입 및 로그인
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    let user = db.users.find(u => u.username === username);

    if (!user) {
        const hashedPassword = await bcrypt.hash(password, 10);
        user = {
            id: db.users.length + 1,
            username,
            password: hashedPassword,
            nickname: username + '학생',
            qpoint: 100,
            manner: 36.5,
            bank: '카카오뱅크',
            account: '3333-01-123456'
        };
        db.users.push(user);
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, nickname: user.nickname, qpoint: user.qpoint, manner: user.manner, bank: user.bank, account: user.account } });
});

// 2. 프로필 업데이트 API
app.put('/api/user/profile', authenticateToken, (req, res) => {
    const { nickname, bank, account } = req.body;
    const user = db.users.find(u => u.id === req.user.id);

    if (user) {
        if (nickname) user.nickname = nickname;
        if (bank) user.bank = bank;
        if (account) user.account = account;
        return res.json({ success: true, user });
    }
    res.status(404).json({ message: '유저를 찾을 수 없습니다.' });
});

// 3. NEIS 오픈 API 연동 (실제 교육청 급식 수집)
app.get('/api/meal', async (req, res) => {
    try {
        const today = new Date().toISOString().slice(0,10).replace(/-/g, "");
        const neisUrl = `https://open.neis.go.kr/hub/mealServiceDietInfo?Type=json&pIndex=1&pSize=100&ATPT_OFCDC_SC_CODE=B10&SD_SCHUL_CODE=7010536&MLSV_YMD=${today}`;
        
        const response = await axios.get(neisUrl);
        const mealData = response.data?.mealServiceDietInfo?.[1]?.row;
        
        if (mealData && mealData.length > 0) {
            const dinner = mealData.find(m => m.MMEAL_SC_CODE === '3') || mealData[0];
            const cleanMenu = dinner.DDISH_NM.replace(/<br\/>/g, ', ').replace(/\([0-9.]+\)/g, '');
            return res.json({ menu: cleanMenu });
        }
        res.json({ menu: '오늘의 석식 정보가 없거나 휴교일입니다.' });
    } catch (e) {
        res.json({ menu: '오늘의 석식: 치킨마요덮밥 & 요아정 아이스크림 (기본값)' });
    }
});

// 4. 석식 양도 API
app.get('/api/trades', (req, res) => {
    res.json(db.trades);
});

app.post('/api/trades', authenticateToken, (req, res) => {
    const { price } = req.body;
    const user = db.users.find(u => u.id === req.user.id);

    const newTrade = {
        id: 't' + Date.now(),
        sellerId: user.id,
        seller: user.nickname,
        price: parseInt(price),
        manner: `${user.manner}℃`,
        bank: user.bank,
        account: user.account,
        status: 'AVAILABLE'
    };
    db.trades.unshift(newTrade);
    io.emit('trade_created', newTrade);
    res.json(newTrade);
});

// 5. 지식iN Q&A API
app.get('/api/qna', (req, res) => {
    res.json(db.questions);
});

app.post('/api/qna', authenticateToken, (req, res) => {
    const { title, content, point } = req.body;
    const user = db.users.find(u => u.id === req.user.id);

    if (user.qpoint < point) {
        return res.status(400).json({ message: '포인트가 부족합니다.' });
    }

    user.qpoint -= parseInt(point);

    const newQna = {
        id: 'q' + Date.now(),
        authorId: user.id,
        author: user.nickname,
        title,
        content,
        point: parseInt(point),
        answers: []
    };
    db.questions.unshift(newQna);
    res.json({ question: newQna, remainingPoint: user.qpoint });
});

// 6. 답변 등록 API
app.post('/api/qna/:id/answer', authenticateToken, (req, res) => {
    const qid = req.params.id;
    const { text } = req.body;
    const user = db.users.find(u => u.id === req.user.id);
    const q = db.questions.find(item => item.id === qid);

    if (!q) return res.status(404).json({ message: '질문을 찾을 수 없습니다.' });

    const newAnswer = {
        id: 'a' + Date.now(),
        authorId: user.id,
        author: user.nickname,
        text,
        isAdopted: false
    };
    q.answers.push(newAnswer);
    res.json(q);
});

// 7. 답변 채택 API
app.post('/api/qna/:qid/adopt/:aid', authenticateToken, (req, res) => {
    const { qid, aid } = req.params;
    const q = db.questions.find(item => item.id === qid);

    if (q.authorId !== req.user.id) {
        return res.status(403).json({ message: '질문자 본인만 채택할 수 있습니다.' });
    }

    const ans = q.answers.find(a => a.id === aid);
    if (!ans || ans.isAdopted) return res.status(400).json({ message: '이미 채택되었거나 유효하지 않은 답변입니다.' });

    ans.isAdopted = true;
    
    const answerAuthor = db.users.find(u => u.id === ans.authorId);
    if (answerAuthor) {
        answerAuthor.qpoint += q.point;
    }

    res.json({ message: '답변이 채택되었습니다.', question: q });
});

// --- [Socket.io 및 서버 바인딩 설정] ---
io.on('connection', (socket) => {
    console.log('클라이언트 연결됨:', socket.id);
});

// Render 포트 수신 및 외부 접속 가능 바인딩 ('0.0.0.0')
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`서라벌고 밥포탈 백엔드 서버 running on port ${PORT}`);
});