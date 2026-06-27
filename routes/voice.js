const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const { extractAndStore } = require('../services/memory');

module.exports = function(app, supabase) {
    // 👇 把 server.js 里的【语音功能】全剪切过来，粘贴在这里！
    
    
};
