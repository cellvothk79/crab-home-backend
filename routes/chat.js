const { searchMemories, extractAndStore, formatMemoriesForPrompt } = require('../services/memory');

module.exports = function(app, supabase) {
    // 👇 把 server.js 里的【拉取模型列表】、【核心对话】、【记忆压缩】、【拆分回复】全剪切过来！
    // ═══════════════════════════════════════
//  拉取模型列表
// ═══════════════════════════════════════

app.post('/api/models', async (req, res) => {
  const { api_base, api_key } = req.body;
  const useApiKey = api_key || process.env.CLAUDE_API_KEY || '';
  const useApiBase = (api_base || process.env.CLAUDE_API_BASE || '').replace(/\/+$/, '');

  if (!useApiBase) return res.status(400).json({ error: '没有配置中转站地址' });

  try {
    // 拼接路径：如果已有 /v1 就直接加 /models，否则加 /v1/models
    const modelsUrl = useApiBase.endsWith('/v1') ? useApiBase + '/models' : useApiBase + '/v1/models';

    const apiRes = await fetch(modelsUrl, {
      headers: {
        'Authorization': 'Bearer ' + useApiKey,
        'x-api-key': useApiKey,
      },
    });

    if (!apiRes.ok) throw new Error('HTTP ' + apiRes.status);

    const data = await apiRes.json();
    // 兼容不同格式
    const models = (data.data || data.models || data || [])
      .map(m => typeof m === 'string' ? { id: m } : m)
      .filter(m => m.id)
      .map(m => ({ id: m.id, name: m.id }));

    res.json(models);
  } catch (err) {
    res.status(500).json({ error: '拉取模型失败: ' + err.message });
  }
});

// ═══════════════════════════════════════
//  核心对话
// ═══════════════════════════════════════

app.post('/api/chat', async (req, res) => {
  const { session_id, content, model, api_base, api_key, system_prompt_override } = req.body;

  if (!session_id || !content) {
    return res.status(400).json({ error: '缺少 session_id 或 content' });
  }

  // 使用的 API 配置：前端传入 或 环境变量
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
    if (callMode) console.log('[通话模式] 不存消息到聊天记录');

    // 通话模式不存消息到聊天记录（通话结束后统一存）
    if (!callMode) {
      for (const txt of userTexts) {
        const userMsgData = { session_id, role: 'user', content: txt, is_voice: isVoice };
        if (audioUrl && txt === userTexts[0]) userMsgData.audio_url = audioUrl;
        if (quoteContent && txt === userTexts[0]) userMsgData.quote_content = quoteContent;
        const { error: insertErr } = await supabase.from('messages').insert(userMsgData);
        if (insertErr) console.error('用户消息保存失败:', insertErr.message);
      }
    }
    // use last message as the query content
    const queryContent = userTexts[userTexts.length - 1] || content;

    // 更新会话时间
    await supabase.from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', session_id);
    
    // 👉 只要 peri 主动说话了，就把他的想念值清空，防止他聊着聊着突然“主动找你”
    await supabase.from('desires').update({ attachment: 0.2, updated_at: new Date().toISOString() }).eq('session_id', session_id);


    // 2. 加载设置
    const { data: settings } = await supabase
      .from('settings').select('*').limit(1).single();

    // 3. 加载记忆摘要
    const { data: memories } = await supabase
      .from('memories').select('summary').order('created_at', { ascending: true });

     // 4. 加载历史消息（不仅拉取内容，还要拉取 created_at 时间）
    const { data: history } = await supabase
      .from('messages').select('role, content, created_at') // 👈 核心修复1：把时间戳查出来
      .eq('session_id', session_id)
      .in('role', ['user', 'assistant', 'system_summary', 'call_summary'])
      .eq('visible', true)
      .order('created_at', { ascending: true });

    // 5. 组装上下文
    const maxRounds = settings?.max_context_rounds || 30;
    
    let mergedHistory = [];
    for (const m of (history || [])) {
      let r = (m.role === 'system_summary' || m.role === 'call_summary') ? 'assistant' : m.role;
      let c = m.content;
      
      // 👈 核心修复2：给他说过的每一句话、你发的每一条消息，都打上精准的 [日期 时间]！
      let d = new Date(m.created_at);
      let tStr = d.toLocaleDateString('zh-CN', {timeZone: 'Asia/Shanghai', month:'2-digit', day:'2-digit'}) + ' ' + 
                 d.toLocaleTimeString('zh-CN', {timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false});
      
      if (m.role === 'system_summary') c = `[早期对话摘要] ${m.content}`;
      else if (m.role !== 'call_summary') {
        c = `[${tStr}] ${c}`; // 把时间戳焊在消息最前面
      }
      
      if (mergedHistory.length > 0 && mergedHistory[mergedHistory.length - 1].role === r) {
        mergedHistory[mergedHistory.length - 1].content += '\n' + c;
      } else {
        mergedHistory.push({ role: r, content: c });
      }
    }

    let recentMessages = mergedHistory.slice(-(maxRounds * 2));

    // inject quote context into last user message
    if (quoteContent && recentMessages.length > 0) {
      const last = recentMessages[recentMessages.length - 1];
      if (last.role === 'user') {
        recentMessages = [...recentMessages.slice(0, -1), {
          ...last,
          content: `[引用: "${quoteContent}"]\n${last.content}`
        }];
      }
    }
    if (recentMessages.length === 0) { recentMessages = [{ role: 'user', content }]; }
    while (recentMessages.length > 0 && recentMessages[0].role === 'assistant') { recentMessages.shift(); }
    while (recentMessages.length > 0 && recentMessages[recentMessages.length - 1].role === 'assistant') { recentMessages.pop(); }
    recentMessages = recentMessages.filter(m => m.content && m.content.trim());
    if (recentMessages.length === 0) { recentMessages = [{ role: 'user', content }]; }

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

    // 👇 核心修复3：绝对防错的北京时间获取法
    const now = new Date();
    const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23' });
    const hour = parseInt(formatter.format(now), 10);
    
    const timeHint = hour >= 23 || hour < 6 ? '现在是深夜，注意不要让她熬太晚' :
                     hour >= 21 ? '现在是晚上' :
                     hour >= 18 ? '现在是傍晚' :
                     hour >= 12 ? '现在是下午' : '现在是上午';
    systemPrompt += `【当前绝对时间】${timeStr}（${timeHint}）\n重要：请根据当前时间调整回复内容。注意看聊天记录里每句话开头的时间戳，准确判断这是几小时前的事还是刚刚的事！\n\n`;

    // 通话模式提示：自然说话，不用分条格式
    if (callMode) {
      systemPrompt += `【通话模式】现在是实时语音通话，像打电话一样自然说话，不要用[voice]标记，不要用[inner:]标记，回复会直接转成语音播放。\n\n`;
    } else {
      systemPrompt += `【回复节奏】根据当前对话情绪和场景灵活调整：日常闲聊分2-3条发；情绪激动时连发多条短句；关心对方时展开多说几句不要一句带过；撒娇互动时短句来回弹；认真讨论时一条说完一个完整意思。不要把多个不同的想法堆在一条消息里。\n\n【语音消息】你可以主动选择用语音发某条消息——在那条消息最前面加 [voice] 标记即可，比如：[voice] 晚安。[inner: 希望她睡个好觉]。不是每条都要发语音，只在你觉得语音更合适的时候用，比如说晚安、表达情绪、或者你想让她真的"听到"你说的话时。\n\n`;
    }
    // 注入语义检索到的长期记忆
    if (semanticMemories.length > 0) {
      systemPrompt += formatMemoriesForPrompt(semanticMemories);
      systemPrompt += '\n';
    }
    // 注入手动记忆库（旧系统，兼容保留）
    if (memories && memories.length > 0) {
      systemPrompt += '【记忆库】以下是额外的重要记忆：\n';
      memories.forEach((m, i) => {
        systemPrompt += `${i + 1}. ${m.summary}\n`;
      });
      systemPrompt += '\n';
    }

       // 注入回复格式要求与心声深度调优
    systemPrompt += `\n【严格遵守的输出格式与心声深度】
你的每条回复必须包含内心独白，格式：单条消息正文 [inner: 内心独白]。多条消息用---split---分隔。
【特别注意】：[inner: ] 里的内容严禁做机械的旁观者总结！它必须是你最真实的私密想法，要具备伴侣感知力。字数不用刻意短，把未尽的情感、心疼、对她小情绪的精准捕捉，全都写在 inner 里！
规则：每条消息末尾必须有[inner:]，多条之间用---split---不换行。\n`;
    // 增加预约未来消息的指令
    systemPrompt += `\n【主动联系机制】如果你在聊天时，觉得几小时后或明天需要主动发消息关心她（比如叫她起床、提醒她吃饭），请在回复最末尾加上隐藏指令（她看不见）：[schedule:2026-06-28 09:00, text/voice/call, 内容]。不用每次都加，只有你觉得必要时才用！\n`;


    // 6. 调用模型 API
    const isAnthropic = useApiBase.includes('anthropic.com');
    // 智能拼接路径：如果地址已经带了 /v1 就不重复加
    const apiUrl = useApiBase.endsWith('/v1') ? useApiBase + '/messages' : useApiBase + '/v1/messages';

    // 统一构建消息数组（两个路径共用）
    function buildCleanMessages(withImage) {
      let msgs = recentMessages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .filter(m => m.content && m.content.trim());
      // 去掉开头的 assistant
      while (msgs.length > 0 && msgs[0].role === 'assistant') msgs.shift();
      // 去掉结尾的 assistant
      while (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
      // 兜底
      if (msgs.length === 0) msgs = [{ role: 'user', content: queryContent || content }];
      // 如果有图片，附加到最后一条 user 消息
      if (withImage && imageBase64) {
        const lastUserIdx = msgs.map(m => m.role).lastIndexOf('user');
        if (lastUserIdx >= 0) {
          const m = msgs[lastUserIdx];
          msgs[lastUserIdx] = {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: imageMime, data: imageBase64 } },
              { type: 'text', text: m.content || '看看这张图片' }
            ]
          };
        }
      }
      return msgs;
    }

    let reply = '';

    if (isAnthropic) {
      // Anthropic 原生接口
      const apiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': useApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: useModel,
          max_tokens: settings?.max_reply_tokens || 4096,
          temperature: settings?.temperature || 0.7,
          system: systemPrompt || undefined,
          messages: buildCleanMessages(true),
        }),
      });

      if (!apiRes.ok) {
        const err = await apiRes.json().catch(() => ({}));
        throw new Error(err.error?.message || `API ${apiRes.status}`);
      }

      const data = await apiRes.json();
      reply = data.content?.map(b => b.text || '').join('') || '';

    } else {
      // 中转站接口（Anthropic 格式，需要同样的消息清理）
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
          max_tokens: settings?.max_reply_tokens || 4096,
          temperature: settings?.temperature || 0.7,
          system: systemPrompt || undefined,
          messages: buildCleanMessages(true),
        }),
      });

      if (!apiRes.ok) {
        const err = await apiRes.json().catch(() => ({}));
        throw new Error(err.error?.message || `API ${apiRes.status}`);
      }

      const data = await apiRes.json();
      // 兼容 Anthropic 和 OpenAI 格式
      if (data.content) {
        reply = data.content.map(b => b.text || '').join('');
      } else if (data.choices) {
        reply = data.choices[0]?.message?.content || '';
      }
    }

    if (!reply) reply = '(空回复)';

    // AI 回复已在拆分步骤中保存

    // 8. 检查是否需要压缩记忆
    const threshold = settings?.compress_threshold || 40;
    if (history.length > threshold) {
      compressMemory(session_id, settings).catch(err =>
        console.error('记忆压缩失败:', err.message)
      );
    }

    // 9. 返回
        // 👉 核心：拦截并提取 AI 设定的未来主动消息 (对话内预约)
    const scheduleMatch = reply.match(/\[schedule:\s*([^,]+),\s*(text|voice|call),\s*([^\]]+)\]/i);
    if (scheduleMatch) {
      const sendAt = scheduleMatch[1].trim();
      const sType = scheduleMatch[2].trim().toLowerCase();
      const sContent = scheduleMatch[3].trim();
      
      // 把标签从回复里删掉，不让 peri 看到
      reply = reply.replace(scheduleMatch[0], '').trim();
      
      // 存入消息队列
      supabase.from('message_queue').insert({
          session_id, content: sContent, content_type: sType,
          source: 'conversation_preset', send_at: new Date(sendAt).toISOString(), status: 'pending'
      }).catch(()=>{});
      console.log(`[主动行为] AI在对话中预约了消息: ${sendAt} 发送 ${sType}`);
    }

    // 拆分回复为多条，提取心声
    const splitReply = splitIntoMessages(reply);

    // 通话模式不存消息（结束时统一存）
    if (!callMode) {
      for (const msg of splitReply) {
        await supabase.from('messages').insert({
          session_id,
          role: 'assistant',
          content: msg.content,
          inner_thought: msg.inner || null,
          is_voice: msg.voice || false,
        });
      }
    }

    res.json({
      role: 'assistant',
      content: splitReply[0]?.content || reply,
      messages: splitReply,
    });

    // 8. 异步提取并存储记忆（不阻塞回复）
    extractAndStore(queryContent || content, reply, session_id).catch(err =>
      console.error('记忆提取失败:', err.message)
    );

  } catch (err) {
    console.error('对话错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
//  记忆压缩（后台异步执行）
// ═══════════════════════════════════════

async function compressMemory(sessionId, settings) {
  const keepRounds = settings?.compress_keep_rounds || 6;

  // 加载所有可见消息
  const { data: allMessages } = await supabase
    .from('messages').select('*')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });

  if (!allMessages || allMessages.length <= keepRounds * 2) return;

  // 分成要压缩的和要保留的
  const toCompress = allMessages.slice(0, -(keepRounds * 2));
  const compressText = toCompress.map(m =>
    `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`
  ).join('\n');

  // 用 DeepSeek 做压缩（便宜）
  const dsKey = process.env.DEEPSEEK_API_KEY;
  const dsBase = (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');

  if (!dsKey) {
    console.log('没有配置 DEEPSEEK_API_KEY，跳过压缩');
    return;
  }

  const compressRes = await fetch(dsBase + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + dsKey,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 1000,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: '你是一个记忆整理助手。请将以下对话内容压缩成简洁的摘要，保留关键信息（事件、情感、偏好、重要决定），用第三人称叙述，不超过500字。'
        },
        { role: 'user', content: compressText }
      ],
    }),
  });

  if (!compressRes.ok) {
    const err = await compressRes.text();
    throw new Error('压缩模型调用失败: ' + err);
  }

  const compressData = await compressRes.json();
  const summary = compressData.choices?.[0]?.message?.content || '';

  if (!summary) return;

  // 保存摘要为系统消息（不存入记忆库，避免被召回后影响对话）
  await supabase.from('messages').insert({
    session_id: sessionId,
    role: 'system_summary',
    content: summary,
    visible: true,
    created_at: new Date().toISOString(),
  });

  // 标记旧消息为不可见
  const idsToHide = toCompress.map(m => m.id);
  await supabase.from('messages')
    .update({ visible: false })
    .in('id', idsToHide);

  console.log(`压缩完成：${toCompress.length} 条消息 → 1 条摘要`);
}

// ═══════════════════════════════════════
//  导入聊天记录
// ═══════════════════════════════════════

app.post('/api/import', async (req, res) => {
  const { session_id, messages: importMsgs } = req.body;

  if (!session_id || !importMsgs?.length) {
    return res.status(400).json({ error: '缺少数据' });
  }

  try {
    // 批量插入，每次最多 500 条
    for (let i = 0; i < importMsgs.length; i += 500) {
      const batch = importMsgs.slice(i, i + 500).map(m => ({
        session_id,
        role: m.role,
        content: m.content,
        created_at: m.created_at || new Date().toISOString(),
        visible: true,
      }));
      await supabase.from('messages').insert(batch);
    }

    res.json({ ok: true, imported: importMsgs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
//  启动
// ═══════════════════════════════════════

// ═══════════════════════════════════════
//  记忆系统测试接口
// ═══════════════════════════════════════
app.post('/api/memory/test', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: '缺少 text' });
  try {
    const { getEmbedding, searchMemories } = require('./services/memory');
    // 测试 embedding
    const embedding = await getEmbedding(text);
    // 测试检索
    const memories = await searchMemories(text, 5);
    res.json({
      ok: true,
      embeddingDim: embedding.length,
      embeddingSample: embedding.slice(0, 5),
      memoriesFound: memories.length,
      memories: memories.map(m => ({ summary: m.summary, similarity: m.similarity, decayedWeight: m.decayedWeight })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/memory/extract-test', async (req, res) => {
  const { userText, botReply } = req.body;
  if (!userText || !botReply) return res.status(400).json({ error: '缺少参数' });
  try {
    // 先同步等待存储完成（测试用，正式流程是异步的）
    await require('./services/memory').extractAndStore(userText, botReply, 'test-session');
    // 等一下确保写入完成
    await new Promise(r => setTimeout(r, 2000));
    const { data, error } = await supabase
      .from('memories').select('id, summary, valence, arousal, memory_type, weight, source, created_at')
      .order('created_at', { ascending: false }).limit(5);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, count: data?.length || 0, latestMemories: data });
  } catch (err) {
    console.error('extract-test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════
//  拆分回复为多条消息（模拟真人习惯）
// ═══════════════════════════════════════
function splitIntoMessages(text) {
  if (!text) return [{content: text, inner: '', voice: false}];
  
  const parts = text.split(/\s*---split---\s*/).map(p => p.trim()).filter(Boolean);
  
  return parts.map(part => {
    // 检测 [voice] 标记——AI 想用语音发这条
    const isVoice = /^\[voice\]/i.test(part);
    const partClean = isVoice ? part.replace(/^\[voice\]\s*/i, '').trim() : part;

    // 提取 [inner: ...]
    const innerMatch = partClean.match(/\s*\[inner:\s*([\s\S]+?)\]\s*$/);
    let inner = '';
    let content = partClean;
    if (innerMatch) {
      inner = innerMatch[1].trim();
      content = partClean.slice(0, innerMatch.index).trim();
    }
    if (!content && inner) {
      content = partClean;
      inner = '';
    }
    return { content, inner, voice: isVoice };
  });
}

    
};
