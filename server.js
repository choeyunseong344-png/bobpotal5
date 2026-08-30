const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS 설정 (모든 도메인 허용)
app.use(cors());
app.use(express.json());

// Gemini API 설정
const apiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);

// 기본 상태 체크 엔드포인트
app.get('/', (req, res) => {
  res.send('Server is running smoothly!');
});

// 채팅 API 엔드포인트
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: '메시지를 입력해주세요.' });
    }

    if (!apiKey) {
      return res.status(500).json({ error: 'Render 환경변수에 GEMINI_API_KEY가 설정되지 않았습니다.' });
    }

    // Gemini 모델 호출
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(message);
    const responseText = result.response.text();

    res.json({ reply: responseText });
  } catch (error) {
    console.error('Error handling chat request:', error);
    res.status(500).json({ error: '서버 에러가 발생했습니다: ' + error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
