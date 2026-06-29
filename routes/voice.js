const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const { extractAndStore } = require('../services/memory');

module.exports = function(app, supabase) {
//  语音功能
// 保存通话记录并提取记忆
app.post('/api/call/save', async (req, res) => {
  const { session_id, transcript, duration, started_at, card_content } = req.body;
  if (!session_id) return res.json({ ok: true });

  try {
    const { error: recErr } = await supabase.from('call_records').insert({
      session_id: parseInt(session_id),
      started_at: started_at || new Date().toISOString(),
      duration: duration || 0,
      transcript,
    });

    let cardId = null;
    if (card_content) {
      const { data: cardData, error: cardErr } = await supabase.from('messages').insert({
        session_id: parseInt(session_id),
        role: 'system',
        content: card_content,
        visible: true,
        created_at: new Date().toISOString()
      }).select('id').single();
      if (!cardErr) cardId = cardData?.id;
    }

    const summary = transcript.map(m => `${m.role === 'user' ? 'peri' : 'AI'}：${m.content}`).join('\n');
    await supabase.from('messages').insert({
      session_id: parseInt(session_id),
      role: 'call_summary',
      content: `[通话记录 ${Math.floor(duration/60)}分${duration%60}秒]\n${summary}`,
      visible: false,
    });

    // 👇 就是这里改了！伪装成普通对话喂给记忆提取器
    const userLines = transcript.filter(m => m.role === 'user').map(m => m.content).join('；');
    const aiLines = transcript.filter(m => m.role === 'assistant').map(m => m.content).join('；');
    if (userLines && aiLines) {
      extractAndStore("【在刚才的语音通话中说】" + userLines, "【在刚才的语音通话中回复】" + aiLines, session_id).catch(() => {});
    }

    res.json({ ok: true, card_id: cardId });
  } catch(e) {
    res.json({ ok: true });
  }
});




// ═══════════════════════════════════════
//  通话专用 streaming 接口（按句切分+每句独立TTS）
// ═══════════════════════════════════════
app.post('/api/call/stream', async (req, res) => {
  const { session_id, content, api_key, api_base, model, tts_channel, tts_lang } = req.body;
  if (!session_id || !content) return res.status(400).json({ error: '缺少参数' });

  const useApiKey = api_key || process.env.CLAUDE_API_KEY || '';
  const useApiBase = (api_base || process.env.CLAUDE_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
  const useModel = model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const { data: history } = await supabase
      .from('messages').select('role, content')
      .eq('session_id', session_id)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: false })
      .limit(20);

    let rawMsgs = [...(history || [])].reverse();
    let msgs = [];
    for (const m of rawMsgs) {
        if (msgs.length > 0 && msgs[msgs.length - 1].role === m.role) {
            msgs[msgs.length - 1].content += '\n' + m.content;
        } else {
            msgs.push({ role: m.role, content: m.content });
        }
    }
    while (msgs.length > 0 && msgs[0].role === 'assistant') msgs.shift();
    
    if (msgs.length === 0) msgs = [{ role: 'user', content }];
    else {
        if (msgs[msgs.length - 1].role === 'user') {
            msgs[msgs.length - 1].content += '\n[通话中] ' + content;
        } else {
            msgs.push({ role: 'user', content: '[通话中] ' + content });
        }
    }

    const apiUrl = useApiBase.endsWith('/v1') ? useApiBase + '/messages' : useApiBase + '/v1/messages';
    const apiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': useApiKey,
        'Authorization': 'Bearer ' + useApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: useModel,
        max_tokens: 1024,
        stream: true,
        system: process.env.DEFAULT_SYSTEM_PROMPT || '你是Claude，正在和peri语音通话，说话自然简短，不要用[voice][inner:]这些标记。',
        messages: msgs,
      }),
    });

    if (!apiRes.ok) {
      const err = await apiRes.json().catch(()=>({}));
      send({ type: 'error', error: err.error?.message || `API ${apiRes.status}` });
      res.end(); return;
    }

    let buffer = '';
    let fullReply = '';
    let sentenceIdx = 0;
    const SPLIT_RE = /([。！？!?…]+|[，,]{1}(?=.{8,}))/;

    const flushSentence = async (sentence) => {
      sentence = sentence.trim();
      if (!sentence) return;
      fullReply += sentence;
      
      // 前端先发送中文文本，用于在悬浮窗上展示
      send({ type: 'text', text: sentence, idx: sentenceIdx });

      // 👇 核心修复：把遗漏的 DeepSeek 翻译补回来！
      let ttsText = sentence;
      if (tts_lang === 'en') {
        try {
          const deepseekKey = process.env.DEEPSEEK_API_KEY;
          if (deepseekKey) {
            const transRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + deepseekKey },
              body: JSON.stringify({
                model: 'deepseek-chat',
                max_tokens: 300,
                temperature: 0.3,
                messages: [{ role: 'user', content: `Translate the following Chinese text to natural English. Output only the translation, nothing else:\n${sentence}` }],
              }),
            });
            const transData = await transRes.json();
            if (transData.choices?.[0]?.message?.content) {
              ttsText = transData.choices[0].message.content.trim();
            }
          }
        } catch(e) {
          console.log('通话翻译失败:', e.message);
        }
      }

      try {
        if (tts_channel === 'elevenlabs' && process.env.ELEVENLABS_API_KEY) {
           const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID||'9CFLhe6Ni1wD0VC6wLLb'}`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY },
             body: JSON.stringify({ text: ttsText.slice(0,200), model_id: 'eleven_multilingual_v2' })
           });
           if (elRes.ok) {
             const buf = await elRes.arrayBuffer();
             send({ type: 'audio', audio: Buffer.from(buf).toString('base64'), idx: sentenceIdx, format: 'mp3' });
           }
        } else if (process.env.MINIMAX_API_KEY) {
          const ttsRes = await fetch(`https://api.minimaxi.com/v1/t2a_v2?GroupId=${process.env.MINIMAX_GROUP_ID||'2067156952080720056'}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.MINIMAX_API_KEY },
            body: JSON.stringify({
              model: 'speech-02-turbo', 
              text: ttsText.slice(0, 200), // 👈 发送翻译后的英文
              stream: false,
              voice_setting: { voice_id: process.env.MINIMAX_VOICE_ID||'clone_voice_1782395480634', speed: 1.0, vol: 1.0, pitch: 0, emotion: 'calm' },
              audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3' },
              language_boost: tts_lang === 'en' ? 'English' : 'Chinese' // 👈 补上 language_boost
            }),
          });
          if (ttsRes.ok) {
            const ttsData = await ttsRes.json();
            if (ttsData.base_resp?.status_code === 0 && ttsData.data?.audio) {
              const audioBase64 = Buffer.from(ttsData.data.audio, 'hex').toString('base64');
              send({ type: 'audio', audio: audioBase64, idx: sentenceIdx, format: 'mp3' });
            }
          }
        }
      } catch(e) {}
      sentenceIdx++;
    };

    const reader = apiRes.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const evt = JSON.parse(data);
          if (evt.type === 'content_block_delta' && evt.delta?.text) {
            buffer += evt.delta.text;
            const match = SPLIT_RE.exec(buffer);
            if (match) {
              const cutAt = match.index + match[0].length;
              await flushSentence(buffer.slice(0, cutAt));
              buffer = buffer.slice(cutAt);
            }
          } else if (evt.choices?.[0]?.delta?.content) {
            buffer += evt.choices[0].delta.content;
            const match = SPLIT_RE.exec(buffer);
            if (match) {
              const cutAt = match.index + match[0].length;
              await flushSentence(buffer.slice(0, cutAt));
              buffer = buffer.slice(cutAt);
            }
          }
        } catch(e) {}
      }
    }
    if (buffer.trim()) await flushSentence(buffer);
    send({ type: 'done', fullReply });
    res.end();
  } catch(e) {
    send({ type: 'error', error: e.message });
    res.end();
  }
});



// 获取通话记录列表
app.get('/api/call/records', async (req, res) => {
  const { session_id } = req.query;
  console.log('[call/records] 查询 session_id:', session_id);
  if (!session_id) return res.status(400).json({ error: '缺少 session_id' });
  const { data, error } = await supabase
    .from('call_records')
    .select('id, started_at, duration, transcript')
    .eq('session_id', parseInt(session_id))
    .order('created_at', { ascending: false })
    .limit(100);
  console.log('[call/records] 结果:', data?.length, '条, error:', error?.message||'无');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// 删除通话记录接口
app.delete('/api/call/records/:id', async (req, res) => {
  const { error } = await supabase.from('call_records').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});


// 上传用户录音到 Supabase Storage
app.post('/api/voice/upload', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到音频文件' });
  try {
    const fileName = `user_voice_${Date.now()}.webm`;
    const { error } = await supabase.storage
      .from('voice-messages')
      .upload(fileName, req.file.buffer, { contentType: 'audio/webm', upsert: false });
    if (error) throw new Error(error.message);
    const { data } = supabase.storage.from('voice-messages').getPublicUrl(fileName);
    res.json({ audioUrl: data.publicUrl });
  } catch(e) {
    console.error('录音上传失败:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Whisper 语音转文字 + 情绪识别
app.post('/api/voice/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到音频文件' });

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return res.status(500).json({ error: '未配置 OPENAI_API_KEY' });

  try {
    // 1. Whisper 转文字（用 Node 18+ 内置 FormData）
    const fd = new FormData();
    const audioBlob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' });
    fd.append('file', audioBlob, 'voice.webm');
    fd.append('model', 'whisper-1');
    fd.append('language', 'zh');
    fd.append('prompt', '这是一段私人聊天的语音消息，内容是日常对话。');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + openaiKey },
      body: fd,
    });

    if (!whisperRes.ok) {
      const err = await whisperRes.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Whisper 失败');
    }

    const whisperData = await whisperRes.json();
    let text = whisperData.text?.trim() || '';

    // 幻觉黑名单过滤
    const hallucinations = ['欢迎订阅','感谢收看','请点赞','关注我','感谢观看','欢迎关注','订阅频道','点赞收藏','一键三连'];
    if(hallucinations.some(h => text.includes(h))) {
      console.log('Whisper 幻觉过滤:', text);
      text = '';
    }

    if (!text) return res.json({ text: '', emotion: '' });

    // 2. 情绪识别（用 DeepSeek，轻量快速）
    let emotion = '';
    try {
      const emotionRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.DEEPSEEK_API_KEY },
        body: JSON.stringify({
          model: 'deepseek-chat',
          max_tokens: 10,
          temperature: 0,
          messages: [{
            role: 'user',
            content: `根据这句话判断说话人的情绪，从以下选项选一个：开心、难过、疲惫、撒娇、生气、平静、兴奋。只输出一个词。\n"${text}"`
          }]
        }),
      });
      const emotionData = await emotionRes.json();
      emotion = emotionData.choices?.[0]?.message?.content?.trim() || '';
    } catch(e) {
      console.log('情绪识别失败，跳过');
    }

    res.json({ text, emotion });
  } catch(err) {
    console.error('语音转写失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ElevenLabs / MiniMax 双通道 TTS
// ElevenLabs / MiniMax 双通道 TTS
app.post('/api/voice/tts', async (req, res) => {
  const { text, emotion, channel, lang } = req.body;
  if (!text) return res.status(400).json({ error: '缺少文字内容' });

  // 文本预处理：数字/符号转口语
  function preprocessTTS(raw) {
    return raw
      .replace(/(\d{4})-(\d{2})-(\d{2})/g, (_, y, m, d) => `${y}年${parseInt(m)}月${parseInt(d)}日`)
      .replace(/(\d+):(\d{2})/g, (_, h, m) => `${parseInt(h)}点${m === '00' ? '整' : parseInt(m) + '分'}`)
      .replace(/￥([\d.]+)/g, (_, n) => `${n}元`)
      .replace(/\$([\d.]+)/g, (_, n) => `${n}美元`)
      .replace(/(\d+)%/g, (_, n) => `${n}百分之`)
      .replace(/Ctrl\+C/gi, '复制').replace(/Ctrl\+V/gi, '粘贴').replace(/Ctrl\+Z/gi, '撤销')
      .slice(0, 500);
  }

  // 情绪 → ElevenLabs Audio Tag
  function emotionToElevenTag(e) {
    const map = { '开心': '[cheerfully]', '兴奋': '[excitedly]', '难过': '[sadly]', '疲惫': '[tiredly]', '撒娇': '[softly]', '生气': '[firmly]', '平静': '[calmly]' };
    return map[e] || '[softly]';
  }

  const cleanText = preprocessTTS(text);

  // 👇 唯一的翻译逻辑，放在最前面统一处理
  let ttsText = cleanText;
  let translatedText = null;
  if (lang === 'en') {
    try {
      const deepseekKey = process.env.DEEPSEEK_API_KEY;
      if (deepseekKey) {
        const transRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + deepseekKey },
          body: JSON.stringify({
            model: 'deepseek-chat',
            max_tokens: 300,
            temperature: 0.3,
            messages: [{ role: 'user', content: `Translate the following Chinese text to natural English. Output only the translation, nothing else:\n${cleanText}` }],
          }),
        });
        const transData = await transRes.json();
        const translated = transData.choices?.[0]?.message?.content?.trim();
        if (translated) {
          ttsText = translated;
          translatedText = translated;
        }
      }
    } catch(e) {
      console.log('翻译失败，使用原文:', e.message);
    }
  }

  // ── ElevenLabs ──
  if (channel === 'elevenlabs') {
    const elevenKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '9CFLhe6Ni1wD0VC6wLLb';
    if (!elevenKey) return res.status(500).json({ error: '未配置 ELEVENLABS_API_KEY' });
    try {
      const tag = emotionToElevenTag(emotion || '平静');
      const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': elevenKey },
        body: JSON.stringify({
          text: `${tag} ${ttsText}`, // 使用翻译后的英文
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.28, similarity_boost: 0.75, style: 0.88, use_speaker_boost: true },
        }),
      });
      if (!ttsRes.ok) { const err = await ttsRes.json().catch(()=>({})); throw new Error(err.detail?.message || 'ElevenLabs 失败'); }
      const buf = await ttsRes.arrayBuffer();
      res.set('Content-Type', 'audio/mpeg');
      return res.send(Buffer.from(buf));
    } catch(err) {
      console.error('ElevenLabs TTS 失败:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── 默认走 MiniMax ──
  const minimaxKey = process.env.MINIMAX_API_KEY;
  const minimaxVoiceId = process.env.MINIMAX_VOICE_ID || 'clone_voice_1782395480634';
  const minimaxGroupId = process.env.MINIMAX_GROUP_ID || '2067156952080720056';
  if (!minimaxKey) return res.status(500).json({ error: '未配置 MINIMAX_API_KEY' });

  function emotionToMinimax(e) {
    const map = { '开心': 'happy', '兴奋': 'happy', '难过': 'sad', '疲惫': 'calm', '撒娇': 'happy', '生气': 'angry', '平静': 'calm' };
    return map[e] || 'calm';
  }

  const isCallMode = req.body?.call_mode || false;
  const minimaxModel = isCallMode ? 'speech-02-turbo' : 'speech-02-hd';
  const minimaxEndpoint = `https://api.minimaxi.com/v1/t2a_v2?GroupId=${minimaxGroupId}`;

  try {
    const ttsRes = await fetch(minimaxEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + minimaxKey,
      },
      body: JSON.stringify({
        model: minimaxModel,
        text: ttsText, // 使用翻译后的英文
        stream: false,
        voice_setting: {
          voice_id: minimaxVoiceId,
          speed: 1.0,
          vol: 1.0,
          pitch: 0,
          emotion: emotionToMinimax(emotion),
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
        },
        language_boost: lang === 'en' ? 'English' : 'Chinese',
      }),
    });

    if (!ttsRes.ok) {
      const err = await ttsRes.json().catch(() => ({}));
      throw new Error(err.base_resp?.status_msg || 'MiniMax TTS 失败');
    }

    const data = await ttsRes.json();
    if (data.base_resp?.status_code !== 0) {
      throw new Error(data.base_resp?.status_msg || 'MiniMax 返回错误');
    }

    const audioBase64 = data.data?.audio;
    if (!audioBase64) throw new Error('MiniMax 没有返回音频数据');

    const audioBuffer = Buffer.from(audioBase64, 'hex');

    if (isCallMode) {
      res.set('Content-Type', 'audio/mpeg');
      return res.send(audioBuffer);
    }

    try {
      const fileName = `voice_${Date.now()}.mp3`;
      const { error: uploadErr } = await supabase.storage
        .from('voice-messages')
        .upload(fileName, audioBuffer, { contentType: 'audio/mpeg', upsert: false });

      if (!uploadErr) {
        const { data: urlData } = supabase.storage
          .from('voice-messages')
          .getPublicUrl(fileName);
        res.set('Content-Type', 'application/json');
        return res.json({ audioUrl: urlData.publicUrl, translatedText });
      }
    } catch(storageErr) {
      console.log('Storage 上传失败，降级返回二进制:', storageErr.message);
    }

    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
  } catch(err) {
    console.error('MiniMax TTS 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

    
    
};
