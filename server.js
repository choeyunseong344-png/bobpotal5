const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const JWT_SECRET = 'SORABOL_BOBPORTAL_ULTIMATE_SECRET_KEY_2026';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ================= [ 데이터베이스 구조 ] =================
let db = {
    users: [],        // 사용자 계정 목록
    trades: [],       // 석식 양도 게시글
    chatRooms: {},    // 1대1 거래 채팅방 및 메시지
    qna: [],          // 지식iN 질문/답변 데이터
    marketItems: [],  // 학교생활 중고거래 물품
    notifications: [],// 개인 알림함 (학번 보관소)
    reports: []       // 신고 내역 (관리자 확인용)
};

// ================= [ 보안 미들웨어 ] =================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: '로그인이 필요합니다.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: '인증 토큰이 유효하지 않습니다.' });
        const dbUser = db.users.find(u => u.id === user.id);
        if (!dbUser) return res.status(404).json({ message: '존재하지 않는 회원입니다.' });
        if (dbUser.isBlocked) return res.status(403).json({ message: '교내 규칙 위반으로 이용 정지된 계정입니다.' });
        req.user = dbUser;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: '관리자 권한이 필요합니다.' });
    }
    next();
};

const sendNotification = (userId, message) => {
    const noti = {
        id: 'noti_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        userId,
        message,
        createdAt: new Date().toLocaleString('ko-KR')
    };
    db.notifications.push(noti);
    io.to(`user_${userId}`).emit('new_notification', noti);
};

// ================= [ 회원가입 / 로그인 / 중복확인 ] =================
app.post('/api/auth/check-username', (req, res) => {
    const { username } = req.body;
    const exists = db.users.some(u => u.username === username);
    res.json({ available: !exists });
});

app.post('/api/auth/check-nickname', (req, res) => {
    const { nickname } = req.body;
    const exists = db.users.some(u => u.nickname === nickname);
    res.json({ available: !exists });
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, nickname, name, phone, grade, classNum, studentNum, mealDays, bank, account, agreeTerms } = req.body;

        if (!agreeTerms) return res.status(400).json({ message: '법적 책임 고지 및 이용약관에 동의해야 합니다.' });
        if (db.users.some(u => u.username === username)) return res.status(400).json({ message: '이미 사용 중인 아이디입니다.' });
        if (db.users.some(u => u.nickname === nickname)) return res.status(400).json({ message: '이미 사용 중인 닉네임입니다.' });
        if (nickname === name) return res.status(400).json({ message: '닉네임은 실명과 동일하게 설정할 수 없습니다.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            id: 'u_' + Date.now(),
            username,
            password: hashedPassword,
            nickname,
            name,
            phone,
            school: '서라벌고등학교',
            grade: parseInt(grade),
            classNum: parseInt(classNum),
            studentNum: parseInt(studentNum),
            mealDays: mealDays || [],
            bank: bank || '',
            account: account || '',
            qpoint: 100,
            isBlocked: false,
            role: username === 'admin' ? 'admin' : 'student',
            createdAt: new Date()
        };

        db.users.push(newUser);
        res.json({ success: true, message: '회원가입이 완료되었습니다.' });
    } catch (e) {
        res.status(500).json({ message: '서버 내부 오류가 발생했습니다.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.users.find(u => u.username === username);

    if (!user) return res.status(400).json({ message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    if (user.isBlocked) return res.status(403).json({ message: '이용 정지된 계정입니다.' });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(400).json({ message: '아이디 또는 비밀번호가 올바르지 않습니다.' });

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
        token,
        user: {
            id: user.id,
            username: user.username,
            nickname: user.nickname,
            name: user.name,
            school: user.school,
            grade: user.grade,
            classNum: user.classNum,
            studentNum: user.studentNum,
            qpoint: user.qpoint,
            role: user.role,
            mealDays: user.mealDays,
            bank: user.bank,
            account: user.account
        }
    });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
    const u = req.user;
    res.json({
        id: u.id, username: u.username, nickname: u.nickname, name: u.name,
        school: u.school, grade: u.grade, classNum: u.classNum, studentNum: u.studentNum,
        qpoint: u.qpoint, role: u.role, mealDays: u.mealDays, bank: u.bank, account: u.account
    });
});

// ================= [ 석식 양도 게시판 (Flashback 규격) ] =================
app.get('/api/trades', authenticateToken, (req, res) => {
    const list = db.trades.map(t => ({
        id: t.id,
        sellerNick: t.sellerNick,
        price: t.price,
        reason: t.reason,
        mealDay: t.mealDay,
        status: t.status,
        createdAt: t.createdAt
    }));
    res.json(list);
});

app.post('/api/trades', authenticateToken, (req, res) => {
    const { price, reason } = req.body;
    const user = req.user;

    const days = ['일', '월', '화', '수', '목', '금', '토'];
    const todayStr = days[new Date().getDay()];

    if (!user.mealDays.includes(todayStr)) {
        return res.status(400).json({ message: `회원님은 오늘(${todayStr}요일) 석식 신청자가 아닙니다.` });
    }

    const todayDate = new Date().toISOString().slice(0, 10);
    const alreadyPosted = db.trades.some(t => t.sellerId === user.id && new Date(t.createdAt).toISOString().slice(0, 10) === todayDate);
    if (alreadyPosted) {
        return res.status(400).json({ message: '석식 게시글은 하루에 1개만 등록할 수 있습니다.' });
    }

    const newTrade = {
        id: 'trade_' + Date.now(),
        sellerId: user.id,
        sellerNick: user.nickname,
        mealDay: todayStr,
        price: parseInt(price),
        reason,
        status: 'AVAILABLE',
        createdAt: new Date(),
        buyerId: null
    };

    db.trades.unshift(newTrade);
    io.emit('trade_created', newTrade);
    res.json({ success: true, trade: newTrade });
});

app.post('/api/trades/:id/request', authenticateToken, (req, res) => {
    const trade = db.trades.find(t => t.id === req.params.id);
    if (!trade) return res.status(404).json({ message: '존재하지 않는 게시글입니다.' });
    if (trade.status !== 'AVAILABLE') return res.status(400).json({ message: '이미 거래가 진행 중이거나 완료된 석식입니다.' });
    if (trade.sellerId === req.user.id) return res.status(400).json({ message: '본인의 석식은 구매할 수 없습니다.' });

    const todayDate = new Date().toISOString().slice(0, 10);
    const alreadyBought = db.trades.some(t => t.buyerId === req.user.id && new Date(t.createdAt).toISOString().slice(0, 10) === todayDate);
    if (alreadyBought) {
        return res.status(400).json({ message: '석식 구매는 하루에 1회만 가능합니다.' });
    }

    trade.status = 'IN_PROGRESS';
    trade.buyerId = req.user.id;

    const roomId = 'chat_' + trade.id;
    const seller = db.users.find(u => u.id === trade.sellerId);

    db.chatRooms[roomId] = {
        id: roomId,
        tradeId: trade.id,
        sellerId: trade.sellerId,
        buyerId: req.user.id,
        sellerNick: trade.sellerNick,
        buyerNick: req.user.nickname,
        sellerBank: seller.bank,
        sellerAccount: seller.account,
        price: trade.price,
        messages: [
            { sender: 'system', text: `[시스템] 안전거래 1대1 채팅이 시작되었습니다.\n판매자 입금 계좌: ${seller.bank} ${seller.account}\n입금 금액: ${trade.price}원` }
        ]
    };

    sendNotification(trade.sellerId, `[석식양도] '${req.user.nickname}' 학생의 구매 요청이 도착했습니다. 채팅방을 확인하세요.`);
    res.json({ roomId });
});

app.get('/api/chat/:roomId', authenticateToken, (req, res) => {
    const room = db.chatRooms[req.params.roomId];
    if (!room) return res.status(404).json({ message: '채팅방을 찾을 수 없습니다.' });
    if (room.sellerId !== req.user.id && room.buyerId !== req.user.id) {
        return res.status(403).json({ message: '접근 권한이 없습니다.' });
    }
    res.json(room);
});

// ================= [ 지식iN 시스템 ] =================
app.get('/api/qna', authenticateToken, (req, res) => {
    const list = db.qna.map(q => ({
        id: q.id,
        authorNick: q.authorNick,
        authorUsername: q.authorUser,
        title: q.title,
        content: q.content,
        point: q.point,
        status: q.status,
        answers: q.answers.map(a => ({ id: a.id, authorNick: a.authorNick, authorUsername: a.authorUser, content: a.content, isAdopted: a.isAdopted }))
    }));
    res.json(list);
});

app.get('/api/qna/rankings', authenticateToken, (req, res) => {
    const sorted = [...db.users].sort((a, b) => b.qpoint - a.qpoint).slice(0, 5);
    const top5 = sorted.map((u, i) => ({ rank: i + 1, nickname: u.nickname, username: u.username, qpoint: u.qpoint }));
    res.json(top5);
});

app.post('/api/qna', authenticateToken, (req, res) => {
    const { title, content, point } = req.body;
    const p = parseInt(point) || 0;
    if (req.user.qpoint < p) return res.status(400).json({ message: '보유한 포인트가 부족합니다.' });

    req.user.qpoint -= p;
    const newQ = {
        id: 'q_' + Date.now(),
        authorId: req.user.id,
        authorNick: req.user.nickname,
        authorUser: req.user.username,
        title,
        content,
        point: p,
        status: 'OPEN',
        answers: []
    };
    db.qna.unshift(newQ);
    res.json(newQ);
});

app.post('/api/qna/:id/answer', authenticateToken, (req, res) => {
    const q = db.qna.find(item => item.id === req.params.id);
    if (!q) return res.status(404).json({ message: '질문을 찾을 수 없습니다.' });

    const newA = {
        id: 'a_' + Date.now(),
        authorId: req.user.id,
        authorNick: req.user.nickname,
        authorUser: req.user.username,
        content: req.body.content,
        isAdopted: false
    };
    q.answers.push(newA);
    sendNotification(q.authorId, `[지식iN] 작성하신 질문에 새로운 답변이 등록되었습니다.`);
    res.json(q);
});

app.post('/api/qna/:qid/adopt/:aid', authenticateToken, (req, res) => {
    const q = db.qna.find(item => item.id === req.params.qid);
    if (!q) return res.status(404).json({ message: '질문이 없습니다.' });
    if (q.authorId !== req.user.id) return res.status(403).json({ message: '본인의 질문에서만 채택이 가능합니다.' });

    const ans = q.answers.find(a => a.id === req.params.aid);
    if (!ans || ans.isAdopted) return res.status(400).json({ message: '채택할 수 없는 답변입니다.' });

    ans.isAdopted = true;
    q.status = 'SOLVED';

    const targetUser = db.users.find(u => u.id === ans.authorId);
    if (targetUser) {
        targetUser.qpoint += q.point;
        sendNotification(targetUser.id, `[지식iN] 답변이 채택되어 ${q.point}P가 적립되었습니다.`);
    }
    res.json({ success: true });
});

// ================= [ 학교생활 당근마켓 시스템 ] =================
app.get('/api/market', authenticateToken, (req, res) => {
    res.json(db.marketItems);
});

app.post('/api/market', authenticateToken, (req, res) => {
    const { title, price, content } = req.body;
    const newItem = {
        id: 'item_' + Date.now(),
        sellerId: req.user.id,
        sellerNick: req.user.nickname,
        title,
        price: parseInt(price),
        content,
        status: 'SELLING',
        createdAt: new Date()
    };
    db.marketItems.unshift(newItem);
    res.json(newItem);
});

// ================= [ 마이페이지 & 알림 ] =================
app.get('/api/user/my-info', authenticateToken, (req, res) => {
    const u = req.user;
    const sorted = [...db.users].sort((a, b) => b.qpoint - a.qpoint);
    const myRank = sorted.findIndex(user => user.id === u.id) + 1;

    const myQna = db.qna.filter(q => q.authorId === u.id);
    const myTrades = db.trades.filter(t => t.sellerId === u.id || t.buyerId === u.id);

    res.json({
        profile: {
            nickname: u.nickname,
            username: u.username,
            school: u.school,
            grade: u.grade,
            classNum: u.classNum,
            studentNum: u.studentNum,
            qpoint: u.qpoint,
            rank: myRank
        },
        qnaList: myQna,
        tradeList: myTrades
    });
});

app.get('/api/notifications', authenticateToken, (req, res) => {
    const userNotis = db.notifications.filter(n => n.userId === req.user.id);
    res.json(userNotis);
});

// ================= [ 신고 & 관리자 전용 제어 ] =================
app.post('/api/report', authenticateToken, (req, res) => {
    const { targetUserId, reason, targetType, targetId } = req.body;
    const report = {
        id: 'rep_' + Date.now(),
        reporterId: req.user.id,
        reporterNick: req.user.nickname,
        targetUserId,
        reason,
        targetType,
        targetId,
        createdAt: new Date()
    };
    db.reports.push(report);
    res.json({ success: true, message: '신고가 접수되었습니다. 관리자가 검토 후 처리합니다.' });
});

app.get('/api/admin/dashboard', authenticateToken, requireAdmin, (req, res) => {
    res.json({
        users: db.users.map(u => ({
            id: u.id,
            username: u.username,
            name: u.name,
            phone: u.phone,
            grade: u.grade,
            classNum: u.classNum,
            studentNum: u.studentNum,
            isBlocked: u.isBlocked
        })),
        trades: db.trades,
        chatRooms: db.chatRooms,
        reports: db.reports,
        qna: db.qna
    });
});

app.post('/api/admin/block-user', authenticateToken, requireAdmin, (req, res) => {
    const { userId } = req.body;
    const target = db.users.find(u => u.id === userId);
    if (target) {
        target.isBlocked = true;
        res.json({ success: true, message: `${target.name} 학생의 계정이 이용 정지되었습니다.` });
    } else {
        res.status(404).json({ message: '해당 학생을 찾을 수 없습니다.' });
    }
});

// ================= [ 소켓 실시간 통신 및 학번 공개 로직 ] =================
io.on('connection', (socket) => {
    socket.on('join_room', ({ roomId, userId }) => {
        socket.join(roomId);
        socket.join(`user_${userId}`);
    });

    socket.on('send_message', ({ roomId, senderNick, text }) => {
        const room = db.chatRooms[roomId];
        if (room) {
            const msg = { sender: senderNick, text, time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) };
            room.messages.push(msg);
            io.to(roomId).emit('receive_message', msg);
        }
    });

    socket.on('confirm_deposit', ({ roomId, userId }) => {
        const room = db.chatRooms[roomId];
        if (room && room.sellerId === userId) {
            const seller = db.users.find(u => u.id === room.sellerId);
            const studentInfo = `${seller.grade}학년 ${seller.classNum}반 ${seller.studentNum}번 (${seller.name})`;
            
            const sysMsg = {
                sender: 'system',
                text: `[거래 완료] 판매자가 입금을 확인했습니다.\n📍 판매자 학번 정보: ${studentInfo}\n⚠️ 무단 학번 도용 시 교내 징계 및 법적 처벌을 받습니다.`,
                time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
            };
            
            room.messages.push(sysMsg);
            io.to(roomId).emit('receive_message', sysMsg);

            sendNotification(room.buyerId, `[석식 거래 완료] 구매하신 석식의 판매자 정보: ${studentInfo}`);
            
            const trade = db.trades.find(t => t.id === room.tradeId);
            if (trade) trade.status = 'COMPLETED';
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`서라벌고 BOB PORTAL 통합 서버가 포트 ${PORT}에서 정상 가동 중입니다.`);
});
