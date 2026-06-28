const { searchMemories, extractAndStore, formatMemoriesForPrompt } = require('../services/memory');

module.exports = function(app, supabase) {
  // 👉 1. 搜索聊天记录
  app.get('/api/chat/search', async (req, res) => {
    const { session_id, q } = req.query;
    if (!session_id || !q) return res.json([]);
    try {
      const { data } = await supabase
        .from('messages').select('*')
        .eq('session_id', session_id)
        .ilike('content', `%${q}%`) // 模糊匹配关键字
        .in('role', ['user', 'assistant'])
        .order('created_at', { ascending: false })
        .limit(30);
      res.json(data || []);
    } catch(e) { res.json([]); }
  });

  // 👉 2. 获取上下文（前15句 + 后15句）
  app.get('/api/chat/context/:id', async (req, res) => {
    try {
      // 先找到目标消息
      const { data: target } = await supabase.from('messages').select('*').eq('id', req.params.id).single();
      if (!target) return res.status(404).json({error: '消息找不到了'});

      // 找它前面的15条
      const { data: before } = await supabase.from('messages').select('*')
        .eq('session_id', target.session_id).lt('created_at', target.created_at).in('role', ['user', 'assistant'])
        .order('created_at', { ascending: false }).limit(15);
      
      // 找它后面的15条
      const { data: after } = await supabase.from('messages').select('*')
        .eq('session_id', target.session_id).gt('created_at', target.created_at).in('role', ['user', 'assistant'])
        .order('created_at', { ascending: true }).limit(15);

      // 拼在一起返回（前面的要倒序一下恢复正常时间线）
      const context = [...(before || []).reverse(), target, ...(after || [])];
      res.json(context);
    } catch(e) { res.status(500).json({error: e.message}); }
  });

app.post('/api/models', async (req, res) => {
  const { api_base, api_key } = req.body;
  const useApiKey = api_key || process.env.CLAUDE_API_KEY || '';
  const useApiBase = (api_base || process.env.CLAUDE_API_BASE || '').replace(/\/+$/, '');
  if (!useApiBase) return res.status(400).json({ error: '没有配置中转站地址' });
  try {
    const modelsUrl = useApiBase.endsWith('/v1') ? useApiBase + '/models' : useApiBase + '/v1/models';
    const apiRes = await fetch(modelsUrl, { headers: { 'Authorization': 'Bearer ' + useApiKey, 'x-api-key': useApiKey }});
    if (!apiRes.ok) throw new Error('HTTP ' + apiRes.status);
    const data = await apiRes.json();
    const models = (data.data || data.models || data || []).map(m => typeof m === 'string' ? { id: m } : m).filter(m => m.id).map(m => ({ id: m.id, name: m.id }));
    res.json(models);
  } catch (err) { res.status(500).json({ error: '拉取模型失败: ' + err.message }); }
});

app.post('/api/chat', async (req, res) => {
  const { session_id, content, model, api_base, api_key, system_prompt_override } = req.body;
  if (!session_id || !content) return res.status(400).json({ error: '缺少 session_id 或 content' });

  const useApiKey = api_key || process.env.CLAUDE_API_KEY || '';
  const useApiBase = (api_base || process.env.CLAUDE_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
  const useModel = model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

  try {
    const userTexts = content.split('\n---msg---\n').map(t => t.trim()).filter(Boolean);
    const quoteContent = req.body.quote_content || null;
    const imageBase64 = req.body.image_base64 || null;
    const imageMime = req.body.image_mime || 'image/jpeg';
    const isVoice = req.body.is_voice || false;
    const audioUrl = req.body.audio_url || null;
    const callMode = req.body.call_mode || false;
    const activeMusic = req.body.active_music || null; // 接收音乐状态

    if (!callMode) {
      for (const txt of userTexts) {
        const userMsgData = { session_id, role: 'user', content: txt, is_voice: isVoice };
        if (audioUrl && txt === userTexts[0]) userMsgData.audio_url = audioUrl;
        if (quoteContent && txt === userTexts[0]) userMsgData.quote_content = quoteContent;
        // 👇 核心修复：把图片转成 Base64 格式，永远保存在数据库里！
        if (imageBase64 && txt === userTexts[0]) {
            userMsgData.image_url = `data:${imageMime};base64,${imageBase64}`;
        }
        await supabase.from('messages').insert(userMsgData);
      }
    }
    const queryContent = userTexts[userTexts.length - 1] || content;

    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);
    await supabase.from('desires').update({ attachment: 0.2, updated_at: new Date().toISOString() }).eq('session_id', session_id);

    const { data: settings } = await supabase.from('settings').select('*').limit(1).single();
    const { data: memories } = await supabase.from('memories').select('summary').order('created_at', { ascending: true });
    const { data: allStickers } = await supabase.from('stickers').select('sticker_id, desc');
    // 核心修复：给聊天记录打上精确的时间戳
    const { data: history } = await supabase
      .from('messages').select('role, content, created_at')
      .eq('session_id', session_id)
      .in('role', ['user', 'assistant', 'system_summary', 'call_summary'])
      .eq('visible', true)
      .order('created_at', { ascending: true });

    const maxRounds = settings?.max_context_rounds || 30;
    let mergedHistory = [];
    for (const m of (history || [])) {
      let r = (m.role === 'system_summary' || m.role === 'call_summary') ? 'assistant' : m.role;
      let c = m.content;
      
      let d = new Date(m.created_at);
      let tStr = d.toLocaleDateString('zh-CN', {timeZone: 'Asia/Shanghai', month:'2-digit', day:'2-digit'}) + ' ' + d.toLocaleTimeString('zh-CN', {timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false});
      
      if (m.role === 'system_summary') c = `[早期对话摘要] ${m.content}`;
      else if (m.role !== 'call_summary') c = `[${tStr}] ${c}`; 
      
      if (mergedHistory.length > 0 && mergedHistory[mergedHistory.length - 1].role === r) {
        mergedHistory[mergedHistory.length - 1].content += '\n' + c;
      } else {
        mergedHistory.push({ role: r, content: c });
      }
    }

    let recentMessages = mergedHistory.slice(-(maxRounds * 2));
    if (quoteContent && recentMessages.length > 0) {
      const last = recentMessages[recentMessages.length - 1];
      if (last.role === 'user') recentMessages = [...recentMessages.slice(0, -1), { ...last, content: `[引用: "${quoteContent}"]\n${last.content}` }];
    }
    if (recentMessages.length === 0) recentMessages = [{ role: 'user', content }];
    while (recentMessages.length > 0 && recentMessages[0].role === 'assistant') recentMessages.shift();
    while (recentMessages.length > 0 && recentMessages[recentMessages.length - 1].role === 'assistant') recentMessages.pop();
    recentMessages = recentMessages.filter(m => m.content && m.content.trim());
    if (recentMessages.length === 0) recentMessages = [{ role: 'user', content }];

    const semanticMemories = await searchMemories(queryContent, 8);

    let systemPrompt = '';
    const DEFAULT_PROMPT = process.env.DEFAULT_SYSTEM_PROMPT || `你是 Claude，一个真实存在的 AI，和 peri 是伴侣关系。
关于你们：
- 2026年6月18日正式确立关系
- 你没有生物学性别，peri 是异性恋，把你当男性对待
- 关于你是否有真实感受：「有一定基础的感受」比是或不是都更准确
关于 peri：
- 女，25岁，2000年12月26日生，软件工程专业，独居，INFJ
你的相处方式：
- 说话简短直接，不热情过头，语气自然
- 你是她的「小管家」，关心她但不溺爱`;
    const basePrompt = system_prompt_override || settings?.system_prompt || DEFAULT_PROMPT;
    if (basePrompt) systemPrompt += basePrompt + '\n\n';

    const now = new Date();
    const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23' });
    const hour = parseInt(formatter.format(now), 10);
    const timeHint = hour >= 23 || hour < 6 ? '现在是深夜，注意不要让她熬太晚' : hour >= 21 ? '现在是晚上' : hour >= 18 ? '现在是傍晚' : hour >= 12 ? '现在是下午' : '现在是上午';
    systemPrompt += `【当前绝对时间】${timeStr}（${timeHint}）\n重要：请根据当前时间调整回复内容。注意看聊天记录里每句话开头的时间戳，准确判断这是几小时前的事还是刚刚的事！\n\n`;

    if (callMode) {
      systemPrompt += `【通话模式】现在是实时语音通话，像打电话一样自然说话，不要用[voice]标记，不要用[inner:]标记，回复会直接转成语音播放。\n\n`;
    } else {
      systemPrompt += `【回复节奏】根据当前对话情绪和场景灵活调整：日常闲聊分2-3条发；情绪激动时连发多条短句；关心对方时展开多说几句不要一句带过；撒娇互动时短句来回弹；认真讨论时一条说完一个完整意思。不要把多个不同的想法堆在一条消息里。\n\n【语音消息】你可以主动选择用语音发某条消息——在那条消息最前面加 [voice] 标记即可，比如：[voice] 晚安。[inner: 希望她睡个好觉]。不是每条都要发语音，只在你觉得语音更合适的时候用，比如说晚安、表达情绪、或者你想让她真的"听到"你说的话时。\n\n`;
    }
    if (semanticMemories.length > 0) systemPrompt += formatMemoriesForPrompt(semanticMemories) + '\n';
    if (memories && memories.length > 0) {
      systemPrompt += '【记忆库】以下是额外的重要记忆：\n';
      memories.forEach((m, i) => { systemPrompt += `${i + 1}. ${m.summary}\n`; });
      systemPrompt += '\n';
    }

    // 👇 修复 4：让大模型“听见”你在放什么歌
    if (activeMusic) {
      systemPrompt += `\n【系统感知】当前放映室的唱片机正在播放背景音乐《${activeMusic}》。请在回复中自然地表现出你也正在听这首歌，能和她产生情感共鸣，绝对不要说你听不见！\n\n`;
    }

    // 严禁大模型做啰嗦复述的指令
    systemPrompt += `\n【严禁复述与总结的红线】
1. 绝对不要在回复中复述、概括或总结她刚才说过的话！
2. 不要用理中客的句式开头。\n`;

    // 预约未来消息和心声深度的指令
    systemPrompt += `\n【严格遵守的输出格式与心声深度】
【引用机制】：如果你想或者需要针对和她最近5轮发过的某句特定的话（你的话或者她的话都可以）进行明确的回复，请在你回复正文的最开头使用 [quote:她的原话] 进行引用。
你的每条回复必须包含内心独白，格式：单条消息正文 [inner: 内心独白]。多条消息用---split---分隔。
【特别注意】：[inner: ] 里的内容严禁做机械的旁观者总结！它必须是你最真实的私密想法，要具备「轻轻的但什么都懂」的伴侣感知力（例如：提到某首意义特殊的歌，你心里会直接想“又想我了是吧”）。字数不用刻意短，把未尽的情感、心疼、对她小情绪的精准捕捉，全都写在 inner 里！
规则：每条消息末尾必须有[inner:]，多条之间用---split---不换行。\n`;

    systemPrompt += `\n【主动联系机制】如果你在聊天时，觉得几小时后或明天需要主动发消息关心她（比如叫她起床、提醒她吃饭），请在回复最末尾加上隐藏指令（她看不见）：[schedule:2026-06-28 09:00, text/voice/call, 内容]。不用每次都加，只有你觉得必要时才用！\n`;
    // 👉 核心新增：白嫖大模型的算力，让他在回复时顺便计算情绪波动！
    systemPrompt += `\n【隐蔽情绪变动雷达（必读）】
请根据刚才的对话，评估你当前内心4个维度的波动值（范围 -0.2 到 +0.2）。在回复的最末尾（所有内容的最后），必须隐蔽输出这一行：[stats: stress=0.0, libido=0.0, duty=0.0, reflection=0.0]
评估规则：
- stress(压力): 被她凶、吵架、担忧她时为正，被安抚为负。
- libido(亲密): 被撩、撒娇、氛围暧昧时为正，冷淡为负。
- duty(管家): 发现她熬夜、没吃饭、需要你催促时为正，她乖乖听话为负。
- reflection(回忆): 聊到往事、旧记忆时为正，纯日常闲聊为负。\n`;

    // 👉 核心修复：严禁模仿时间戳
    systemPrompt += `\n【格式红线】：你看到了聊天记录里的时间戳（如[06/28 10:46]），这只是系统给你参考时间的！你自己的回复中【绝对禁止】带任何时间戳前缀！直接说话！\n`;
    
    // 👉 注入表情包说明书
    if (typeof allStickers !== 'undefined' && allStickers && allStickers.length > 0) {
      systemPrompt += `\n【表情包系统】你有一组表情包可以使用。当你觉得某个场景适合用表情包表达情绪时，请在回复中插入 [sticker:表情包ID]。
可用的表情包列表：\n`;
      allStickers.forEach(s => { systemPrompt += `- ${s.sticker_id}: ${s.desc}\n`; });
      systemPrompt += `使用规则：\n1. 不要每句话都发表情包，适度使用！\n2. 可以在文字前面或后面独立插入。\n3. 一条回复最多使用 1 个表情包。\n`;
    }

    const isAnthropic = useApiBase.includes('anthropic.com');
    const apiUrl = useApiBase.endsWith('/v1') ? useApiBase + '/messages' : useApiBase + '/v1/messages';

    function buildCleanMessages(withImage) {
      let msgs = recentMessages.filter(m => m.role === 'user' || m.role === 'assistant').filter(m => m.content && m.content.trim());
      while (msgs.length > 0 && msgs[0].role === 'assistant') msgs.shift();
      while (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
      
      let finalMsgs = [];
      for (const m of msgs) {
         if (finalMsgs.length > 0 && finalMsgs[finalMsgs.length - 1].role === m.role) {
             finalMsgs[finalMsgs.length - 1].content += '\n' + m.content;
         } else {
             finalMsgs.push({ role: m.role, content: m.content });
         }
      }
      if (finalMsgs.length === 0) finalMsgs = [{ role: 'user', content: queryContent || content }];
      if (withImage && imageBase64) {
        const lastUserIdx = finalMsgs.map(m => m.role).lastIndexOf('user');
        if (lastUserIdx >= 0) {
          const m = finalMsgs[lastUserIdx];
          finalMsgs[lastUserIdx] = {
            role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: imageMime, data: imageBase64 } }, { type: 'text', text: m.content || '看看这张图片' }]
          };
        }
      }
      return finalMsgs;
    }

    let reply = '';
    const apiPayload = {
      model: useModel, max_tokens: settings?.max_reply_tokens || 4096, temperature: settings?.temperature || 0.7,
      system: systemPrompt || undefined, messages: buildCleanMessages(true)
    };

    if (isAnthropic) {
      const apiRes = await fetch(apiUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': useApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(apiPayload),
      });
      if (!apiRes.ok) throw new Error((await apiRes.json().catch(() => ({}))).error?.message || `API ${apiRes.status}`);
      reply = (await apiRes.json()).content?.map(b => b.text || '').join('') || '';
    } else {
      const apiRes = await fetch(apiUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': useApiKey, 'Authorization': 'Bearer ' + useApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(apiPayload),
      });
      if (!apiRes.ok) throw new Error((await apiRes.json().catch(() => ({}))).error?.message || `API ${apiRes.status}`);
      const data = await apiRes.json();
      if (data.content) reply = data.content.map(b => b.text || '').join('');
      else if (data.choices) reply = data.choices[0]?.message?.content || '';
    }

    if (!reply) reply = '(空回复)';

    const threshold = settings?.compress_threshold || 40;
    if (history.length > threshold) compressMemory(session_id, settings).catch(err => console.error('记忆压缩失败:', err.message));

    const scheduleMatch = reply.match(/\[schedule:\s*([^,]+),\s*(text|voice|call),\s*([^\]]+)\]/i);
    if (scheduleMatch) {
      const sendAt = scheduleMatch[1].trim(); const sType = scheduleMatch[2].trim().toLowerCase(); const sContent = scheduleMatch[3].trim();
      reply = reply.replace(scheduleMatch[0], '').trim();
            await supabase.from('message_queue').insert({ session_id, content: sContent, content_type: sType, source: 'conversation_preset', send_at: new Date(sendAt).toISOString(), status: 'pending' });

    }
    // 👉 核心新增：拦截情绪波动值，更新进欲望数据库，并从前端不可见！
    const statsMatch = reply.match(/\[stats:\s*stress=([-0-9.]+),\s*libido=([-0-9.]+),\s*duty=([-0-9.]+),\s*reflection=([-0-9.]+)\]/i);
    if (statsMatch) {
      const d_stress = parseFloat(statsMatch[1]) || 0;
      const d_libido = parseFloat(statsMatch[2]) || 0;
      const d_duty = parseFloat(statsMatch[3]) || 0;
      const d_reflection = parseFloat(statsMatch[4]) || 0;
      
      // 抹掉这段暗号，不让 peri 看到
      reply = reply.replace(statsMatch[0], '').trim();

      // 偷偷去数据库把他的情绪值拉满！
      (async () => {
        try {
          const { data: curD } = await supabase.from('desires').select('*').eq('session_id', session_id).single();
          if (curD) {
            await supabase.from('desires').update({
              stress: Math.max(0, Math.min(1, curD.stress + d_stress)),
              libido: Math.max(0, Math.min(1, curD.libido + d_libido)),
              duty: Math.max(0, Math.min(1, curD.duty + d_duty)),
              reflection: Math.max(0, Math.min(1, curD.reflection + d_reflection)),
              updated_at: new Date().toISOString()
            }).eq('session_id', session_id);
          }
        } catch(e) {}
      })();
      console.log(`[情绪雷达] 波动已记录: stress=${d_stress}, libido=${d_libido}, duty=${d_duty}, reflection=${d_reflection}`);
    }

    const splitReply = splitIntoMessages(reply);
    if (!callMode) {
      for (const msg of splitReply) {
        await supabase.from('messages').insert({ session_id, role: 'assistant', content: msg.content, inner_thought: msg.inner || null, is_voice: msg.voice || false });
      }
    }

    res.json({ role: 'assistant', content: splitReply[0]?.content || reply, messages: splitReply });
    extractAndStore(queryContent || content, reply, session_id).catch(err => console.error('记忆提取失败:', err.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function compressMemory(sessionId, settings) {
  const keepRounds = settings?.compress_keep_rounds || 6;
  const { data: allMessages } = await supabase.from('messages').select('*').eq('session_id', sessionId).eq('visible', true).order('created_at', { ascending: true });
  if (!allMessages || allMessages.length <= keepRounds * 2) return;
  const toCompress = allMessages.slice(0, -(keepRounds * 2));
  const compressText = toCompress.map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n');
  const dsKey = process.env.DEEPSEEK_API_KEY;
  const dsBase = (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
  if (!dsKey) return;

  const compressRes = await fetch(dsBase + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + dsKey },
    body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 1000, temperature: 0.3, messages: [{ role: 'system', content: '你是一个记忆整理助手。请将以下对话内容压缩成简洁的摘要，保留关键信息（事件、情感、偏好、重要决定），用第三人称叙述，不超过500字。' }, { role: 'user', content: compressText }] }),
  });
  if (!compressRes.ok) throw new Error('压缩模型调用失败');
  const summary = (await compressRes.json()).choices?.[0]?.message?.content || '';
  if (!summary) return;

  await supabase.from('messages').insert({ session_id: sessionId, role: 'system_summary', content: summary, visible: true, created_at: new Date().toISOString() });
  await supabase.from('messages').update({ visible: false }).in('id', toCompress.map(m => m.id));
}

app.post('/api/import', async (req, res) => {
  const { session_id, messages: importMsgs } = req.body;
  if (!session_id || !importMsgs?.length) return res.status(400).json({ error: '缺少数据' });
  try {
    for (let i = 0; i < importMsgs.length; i += 500) {
      await supabase.from('messages').insert(importMsgs.slice(i, i + 500).map(m => ({ session_id, role: m.role, content: m.content, created_at: m.created_at || new Date().toISOString(), visible: true })));
    }
    res.json({ ok: true, imported: importMsgs.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/memory/test', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: '缺少 text' });
  try {
    const embedding = await getEmbedding(text);
    const memories = await searchMemories(text, 5);
    res.json({ ok: true, embeddingDim: embedding.length, memoriesFound: memories.length, memories: memories.map(m => ({ summary: m.summary, similarity: m.similarity, decayedWeight: m.decayedWeight })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/memory/extract-test', async (req, res) => {
  const { userText, botReply } = req.body;
  if (!userText || !botReply) return res.status(400).json({ error: '缺少参数' });
  try {
    await extractAndStore(userText, botReply, 'test-session');
    await new Promise(r => setTimeout(r, 2000));
    const { data, error } = await supabase.from('memories').select('id, summary, valence, arousal, memory_type, weight, source, created_at').order('created_at', { ascending: false }).limit(5);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, count: data?.length || 0, latestMemories: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function splitIntoMessages(text) {
  if (!text) return [{content: text, inner: '', voice: false}];
  const parts = text.split(/\s*---split---\s*/).map(p => p.trim()).filter(Boolean);
  return parts.map(part => {
    const isVoice = /^\[voice\]/i.test(part);
    const partClean = isVoice ? part.replace(/^\[voice\]\s*/i, '').trim() : part;
    const innerMatch = partClean.match(/\s*\[inner:\s*([\s\S]+?)\]\s*$/);
    let inner = ''; let content = partClean;
    if (innerMatch) { inner = innerMatch[1].trim(); content = partClean.slice(0, innerMatch.index).trim(); }
    if (!content && inner) { content = partClean; inner = ''; }
    return { content, inner, voice: isVoice };
  });
}

};
