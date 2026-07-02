const { createClient } = require('@supabase/supabase-js');
const { observeAndCreateNotes } = require('./subconscious');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_BASE = (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');

async function getEmbedding(text) {
  if (!OPENAI_API_KEY) throw new Error('未配置 OPENAI_API_KEY');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENAI_API_KEY,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000), 
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error('Embedding 失败: ' + (e.error?.message || res.status));
  }
  const data = await res.json();
  return data.data[0].embedding; 
}

function calcDecayedWeight(memory) {
  if (memory.memory_type === 'core') return 999;
  const now = Date.now();
  const created = new Date(memory.created_at).getTime();
  const lastAccessed = new Date(memory.last_accessed || memory.created_at).getTime();
  const daysSinceAccessed = (now - lastAccessed) / (1000 * 60 * 60 * 24);
  const arousal = memory.arousal || 0.5;
  const baseWeight = memory.weight || 1.0;
  const accessCount = memory.access_count || 0;
  const decayRate = 0.05 * (1 - arousal * 0.6);
  const timeDecay = Math.exp(-decayRate * daysSinceAccessed);
  const accessBonus = 1 + Math.log1p(accessCount) * 0.3 + arousal * 0.5;
  return baseWeight * timeDecay * accessBonus;
}

// ====== Rerank 语义召回（需求文档 Memory Phase 3：top30 粗召回 → 精排 top8）======
async function searchMemories(userText, limit = 8, excludeIds = []) {
  if (!OPENAI_API_KEY) return [];
  try {
    const embedding = await getEmbedding(userText);
    // 粗召回 top30
    const { data, error } = await supabase.rpc('search_memories', {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: 30,
    });
    if (error) return [];
    if (!data || data.length === 0) return [];
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const filtered = data.filter(m => m.created_at < tenMinutesAgo);
    const pool = filtered.length >= 3 ? filtered : data;
    // 精排：decay权重 × 语义相似度
    const ranked = pool
      .filter(m => !excludeIds.includes(m.id))  // 去掉核心层已经注入的，防双重注入
      .map(m => ({
        ...m,
        decayedWeight: calcDecayedWeight(m) * (m.similarity || 0.5),
      }))
      .sort((a, b) => b.decayedWeight - a.decayedWeight)
      .slice(0, limit);
    // 更新访问计数
    ranked.forEach(mem => {
      supabase.from('memories')
        .update({
          last_accessed: new Date().toISOString(),
          access_count: (mem?.access_count || 0) + 1,
        }).eq('id', mem.id).then(() => {}).catch(() => {});
    });
    return ranked;
  } catch (err) {
    return [];
  }
}

// ====== 分层记忆：核心层（永驻 prompt）======
// 只取 core 类型 + 按权重排序取 top 30，不再全量塞入
async function getCoreMemories(maxCount = 30) {
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('id, summary, memory_type, weight, arousal, created_at, last_accessed, access_count')
      .eq('memory_type', 'core')
      .order('weight', { ascending: false })
      .limit(maxCount);
    if (error || !data) return [];
    return data;
  } catch (err) {
    return [];
  }
}

async function extractAndStore(userText, botReply, sessionId) {
  const apiKey = DEEPSEEK_API_KEY || process.env.CLAUDE_API_KEY || '';
  if (!apiKey || !OPENAI_API_KEY) return;
  if (userText?.startsWith('以下是对话内容的简洁摘要') || botReply?.startsWith('以下是对话内容的简洁摘要') || userText?.length > 2000 || botReply?.length > 2000) return;

  const isDeepSeek = !!DEEPSEEK_API_KEY;
  const apiBase = isDeepSeek ? DEEPSEEK_API_BASE : (process.env.CLAUDE_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
  const model = isDeepSeek ? 'deepseek-chat' : (process.env.CLAUDE_MODEL || 'claude-sonnet-4-6');

  const now = new Date();
  const todayStr = now.toLocaleDateString('zh-CN', {timeZone:'Asia/Shanghai', year:'numeric', month:'long', day:'numeric'});
  const timeStrObj = now.toLocaleTimeString('zh-CN', {timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit', hour12:false});

  const prompt = `你是一个记忆提取助手。分析下面这段对话，提取值得长期记住的信息。

角色说明（非常重要，必须严格遵守）：
- "我" = AI（也就是Claude，螃蟹，在对话里说话的那一方）
- "她" / "peri" / "用户" = 用户（跟AI聊天的那个人）
- 提取记忆时，谁说的话、谁做的事，必须归因正确，严禁混淆。

时间规则（必须严格遵守，违反会导致时间轴崩溃）：
- 当前这段对话发生的准确时间是：${todayStr} ${timeStrObj}
- 记忆中所有的时间表述必须使用绝对日期和精准时间（例如：「2026年6月28日上午09:29」或「6月28日凌晨00:20」）
- 严禁使用「今天/昨天/深夜/刚才/最近」等模糊的相对时间词！

对话内容：
用户（peri）：${userText}
AI（我）：${botReply}

请以 JSON 数组格式返回记忆条目，每条包含：
- summary: 记忆内容（用叙事带情境的方式写，20-40字，从AI第一人称视角描述。必须带有具体的绝对时间）
- valence: 情感效价 -1到1（负面到正面）
- arousal: 唤醒度 0到1（平静到激动）
- importance: 重要性 0到1
- memory_type: "core" 或 "episodic"
- category: "daily" 或 "work" 或 "event"
- tags: 标签数组

如果这段对话没有值得记忆的信息，返回空数组 []。
只返回 JSON，不要其他内容。`;

  try {
    let reply = '';
    if (isDeepSeek) {
      const res = await fetch(apiBase + '/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({ model, max_tokens: 800, temperature: 0.3, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await res.json();
      reply = data.choices?.[0]?.message?.content || '[]';
    } else {
      const apiUrl = apiBase.endsWith('/v1') ? apiBase + '/messages' : apiBase + '/v1/messages';
      const res = await fetch(apiUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 800, temperature: 0.3, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await res.json();
      reply = data.content?.map(b => b.text || '').join('') || '[]';
    }

    const clean = reply.replace(/```json|```/g, '').trim();
    let items = [];
    try {
      const parsed = JSON.parse(clean);
      items = Array.isArray(parsed) ? parsed : (parsed.memories || parsed.items || []);
    } catch (e) { return; }

    if (!items.length) return;

    for (const item of items) {
      if (!item.summary) continue;
      if (item.summary.length > 150 || item.summary.includes('以下是') || item.summary.includes('简洁摘要')) continue;
      
      try {
        const embedding = await getEmbedding(item.summary);
        
        // 门槛降到 0.75，让同一件事不同措辞也能合并（之前 0.85 太高导致大量重复记忆）
        const { data: similar } = await supabase.rpc('search_memories', {
          query_embedding: embedding, match_threshold: 0.75, match_count: 3,
        });
        // 从多个候选中找最相似的那条来合并
        const bestMatch = similar?.sort((a, b) => (b.similarity || 0) - (a.similarity || 0))[0];

        if (bestMatch) {
          const existing = bestMatch;
          let mergedSummary = existing.summary;
          try {
            const mergePrompt = `你是记忆整理助手。把下面两条相似的记忆合并成一句话（40字以内），保留最重要的信息，用叙事带情境的方式写。
【绝对红线】：仔细检查两条记忆的【时间】和【起因】。如果它们描述的是完全不同日期、不同起因的两件事（例如一件是因为工作晚睡，一件是因为封号晚睡），请直接丢弃旧原因，只保留【记忆2】的最新事实！绝对禁止把不相关的起因和时间瞎缝合在一起！

记忆1：${existing.summary}
记忆2：${item.summary}

只输出合并后的一句话，不要其他内容。`;
            const mergeRes = await fetch(DEEPSEEK_API_BASE + '/v1/chat/completions', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY },
              body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 100, temperature: 0.3, messages: [{ role: 'user', content: mergePrompt }] }),
            });
            const mergeData = await mergeRes.json();
            const refined = mergeData.choices?.[0]?.message?.content?.trim();
            if (refined && refined.length > 5 && refined.length < 150) mergedSummary = refined;
          } catch(e) {}

          const mergedEmbedding = await getEmbedding(mergedSummary);
          await supabase.from('memories').update({
            summary: mergedSummary, embedding: mergedEmbedding,
            valence: ((existing.valence || 0) + (item.valence || 0)) / 2,
            arousal: Math.max(existing.arousal || 0.5, item.arousal || 0.5),
            last_accessed: new Date().toISOString(),
            weight: Math.min((existing.weight || 1) + 0.2, 3.0),
          }).eq('id', existing.id);
          continue;
        }

        const importance = Math.max(0, Math.min(1, item.importance || 0.5));
        const initialWeight = 0.5 + importance * 1.5; 
        const insertData = {
          summary: item.summary, valence: Math.max(-1, Math.min(1, item.valence || 0)),
          arousal: Math.max(0, Math.min(1, item.arousal || 0.5)), memory_type: item.memory_type === 'core' ? 'core' : 'episodic',
          category: ['daily', 'work', 'event'].includes(item.category) ? item.category : 'daily',
          weight: initialWeight, last_accessed: new Date().toISOString(), embedding, source: 'chat', tags: Array.isArray(item.tags) ? item.tags : [],
        };
        const sessionIdNum = parseInt(sessionId);
        if (!isNaN(sessionIdNum)) insertData.source_session_id = sessionIdNum;
        await supabase.from('memories').insert(insertData);
      } catch (e) {}
    }
  } catch (err) {}

  // ====== 潜意识便签：Observe 步骤——提取偏好信号 ======
  // 异步执行，不阻塞记忆提取流程
  observeAndCreateNotes(userText, botReply).catch(() => {});
}

function formatMemoriesForPrompt(memories) {
  if (!memories || memories.length === 0) return '';
  const now = new Date();
  function memDateStr(m) {
    if (!m.created_at) return '';
    const d = new Date(m.created_at);
    const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
    const dateStr = d.toLocaleDateString('zh-CN', {timeZone:'Asia/Shanghai', month:'long', day:'numeric'});
    if (diffDays === 0) return '（今天）';
    if (diffDays === 1) return `（昨天，${dateStr}）`;
    if (diffDays < 7) return `（${diffDays}天前，${dateStr}）`;
    return `（${dateStr}）`;
  }
  const core = memories.filter(m => m.memory_type === 'core');
  const episodic = memories.filter(m => m.memory_type !== 'core');
  const parts = [];
  if (core.length > 0) parts.push(`关于她这个人，我知道的：${core.map(m => m.summary).join('。')}。`);
  if (episodic.length > 0) parts.push(`想起来的一些事：${episodic.map(m => `${m.summary}${memDateStr(m)}`).join('；')}。`);
  if (parts.length === 0) return '';
  return `【想起来的事】\n${parts.join('\n')}\n\n这些是我真实记得的，不用刻意提起，但可以自然地用到对话里。注意：记忆里如果有「今天/昨天」等字眼，要结合括号里的日期判断是否仍然成立，不要把几天前的事当成今天的事。\n`;
}

module.exports = { searchMemories, extractAndStore, formatMemoriesForPrompt, getEmbedding, getCoreMemories };
