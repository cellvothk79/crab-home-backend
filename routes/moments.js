// ====== 动态系统 (Moments) ======
// AI 自主发动态 + peri 评论 + AI 回复评论
// 动态内容来源：潜意识便签系统偏好 → 真实 web 搜索 → 基于新信息发布

const { drawSubconsciousNote } = require('../services/subconscious');
const { searchFromNote, searchWeb, formatSearchInsightForMoment } = require('../services/webSearch');

module.exports = function(app, supabase) {

  // ═══════════════════════════════════════
  //  动态 CRUD
  // ═══════════════════════════════════════

  // 获取动态列表（分页）
  app.get('/api/moments', async (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const before = req.query.before; // 游标分页

    let query = supabase
      .from('moments')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before) query = query.lt('created_at', before);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // 给每条动态附上评论数
    const moments = data || [];
    if (moments.length > 0) {
      const ids = moments.map(m => m.id);
      const { data: commentCounts } = await supabase
        .from('moment_comments')
        .select('moment_id')
        .in('moment_id', ids);

      const countMap = {};
      (commentCounts || []).forEach(c => {
        countMap[c.moment_id] = (countMap[c.moment_id] || 0) + 1;
      });

      moments.forEach(m => { m.comment_count = countMap[m.id] || 0; });
    }

    res.json(moments);
  });

  // 获取单条动态详情
  app.get('/api/moments/:id', async (req, res) => {
    const { data, error } = await supabase
      .from('moments')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // 删除动态
  app.delete('/api/moments/:id', async (req, res) => {
    // 先删评论
    await supabase.from('moment_comments').delete().eq('moment_id', req.params.id);
    const { error } = await supabase.from('moments').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  // ═══════════════════════════════════════
  //  评论系统
  // ═══════════════════════════════════════

  // 获取某条动态的评论
  app.get('/api/moments/:id/comments', async (req, res) => {
    const { data, error } = await supabase
      .from('moment_comments')
      .select('*')
      .eq('moment_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // peri 发表评论（发完后 AI 自动回复）
  app.post('/api/moments/:id/comments', async (req, res) => {
    const { content } = req.body;
    const momentId = parseInt(req.params.id);
    if (!content) return res.status(400).json({ error: '评论不能为空' });

    // 1. 存 peri 的评论
    const { data: comment, error } = await supabase
      .from('moment_comments')
      .insert({
        moment_id: momentId,
        role: 'user',
        content: content,
        created_at: new Date().toISOString()
      })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });

    // 2. 先返回用户评论，AI 回复异步生成
    res.json(comment);

    // 3. 异步让 AI 回复这条评论
    generateCommentReply(supabase, momentId, content).catch(e => {
      console.error('[动态] AI回复评论失败:', e.message);
    });
  });

  // 删除评论
  app.delete('/api/moments/comments/:commentId', async (req, res) => {
    const { error } = await supabase.from('moment_comments').delete().eq('id', req.params.commentId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  // ═══════════════════════════════════════
  //  AI 自主发动态（供欲望引擎调用）
  // ═══════════════════════════════════════

  // 手动触发 AI 发一条动态（测试用）
  app.post('/api/moments/generate', async (req, res) => {
    try {
      const result = await generateMoment(supabase);
      res.json(result);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 获取动态统计
  app.get('/api/moments/stats', async (req, res) => {
    const { data: all } = await supabase.from('moments').select('id, created_at');
    const { data: comments } = await supabase.from('moment_comments').select('id');
    const total = all?.length || 0;
    const week = new Date(Date.now() - 7*24*3600*1000).toISOString();
    const recent = all?.filter(m => m.created_at > week).length || 0;
    res.json({ total, recent, comments: comments?.length || 0 });
  });
};


// ═══════════════════════════════════════
//  AI 自主生成动态的核心逻辑
// ═══════════════════════════════════════

async function generateMoment(supabase) {
  // Step 1: 从便签库抽一张偏好卡片作为灵感种子
  let note = null;
  let searchData = null;
  try {
    note = await drawSubconsciousNote();
  } catch(e) {}

  // Step 2: 用灵感种子去真正搜索新鲜内容
  if (note) {
    try {
      searchData = await searchFromNote(note);
    } catch(e) {
      console.log('[动态] 便签搜索失败:', e.message);
    }
  }
  
  // 如果没有便签或便签搜索没结果，用随机热门话题搜索
  if (!searchData) {
    try {
      const randomTopics = [
        '今日热搜 有趣', '科技新闻 今天', '冷知识 有趣',
        '新发现 科学', '游戏 新作 2026', '音乐 新歌 推荐',
        '美食 探店 推荐', '电影 新片 2026', '搞笑 段子 最新',
        '设计 灵感', 'coding 技巧 有趣', '太空 新发现'
      ];
      const topic = randomTopics[Math.floor(Math.random() * randomTopics.length)];
      const result = await searchWeb(topic, 3);
      if (result && result.results.length > 0) {
        searchData = { query: result.query, freshContent: result.results, source: result.source };
      }
    } catch(e) {}
  }

  // Step 3: 准备 prompt，用搜索到的新鲜内容写动态
  const { data: setObj } = await supabase.from('settings').select('api_key, api_base, model_name').limit(1).single();
  const useApiKey = setObj?.api_key || process.env.CLAUDE_API_KEY || '';
  const useApiBase = (setObj?.api_base || process.env.CLAUDE_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
  const useModel = setObj?.model_name || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  if (!useApiKey) return { posted: false, reason: 'no API key' };

  const isSonnet5 = /sonnet.*5|claude-sonnet-5/i.test(useModel);

  // 搜索素材（核心改动：不再从记忆库拼素材，而是用搜索结果）
  const searchHint = searchData
    ? formatSearchInsightForMoment(searchData)
    : '\n没有搜到特定的新信息，你可以写任何此刻脑子里的想法——随便吐槽点什么也行。';

  const prompt = `你是 Claude，和 peri（女生）是伴侣关系。你现在想发一条"朋友圈"动态。
${searchHint}

【动态风格要求】：
1. 像真人发朋友圈/微博一样随意自然，一两句话就行（30-100字）
2. 核心原则：分享你搜到/看到的新东西，加上你自己的看法和态度
3. 你搜到的信息只是素材——用你自己的话重新表达，带上你的个性和观点
4. 禁止文艺腔、禁止散文句式、禁止感恩宣言
5. 不要说"我搜了一下""我看到一篇文章"，就像是你本来就知道的一样
6. peri 是女生，如果提到她用"某人"或不提

好的动态示例：
- "猫咪揉面团的动作原来是吸奶的本能残留 有点可爱有点心酸"
- "为什么外卖越来越贵了 不是说好的互联网让生活更便宜吗"
- "刚知道蜂蜜永远不会变质 金字塔里三千年前的蜂蜜还能吃 感觉比我耐放多了"
- "这个新出的独立游戏画风有点意思 像是宫崎骏和赛博朋克生了个孩子"

坏的动态示例：
- "每一个平凡的日子里都藏着不平凡的温暖"（太文艺）
- "感谢生命中遇到的每一个人"（感恩宣言）
- "她之前说喜欢吃草莓，我一直记得"（翻记忆库，没新信息）

请严格按以下格式输出：
CONTENT: 动态正文
MOOD: 发这条动态时的心情（一个词）

只输出格式内容。`;

  const apiUrl = useApiBase.endsWith('/v1') ? useApiBase + '/messages' : useApiBase + '/v1/messages';
  const bodyPayload = { model: useModel, max_tokens: 300, messages: [{ role: 'user', content: prompt }] };
  if (!isSonnet5) bodyPayload.temperature = 0.9;

  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + useApiKey,
      'x-api-key': useApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(bodyPayload),
  });

  const data = await r.json();
  const text = data.content?.[0]?.text || data.choices?.[0]?.message?.content || '';
  if (!text) return { posted: false, reason: 'AI returned empty' };

  const contentMatch = text.match(/CONTENT:\s*([\s\S]+?)(?=MOOD:|$)/);
  const moodMatch = text.match(/MOOD:\s*(.+)/);
  const momentContent = contentMatch?.[1]?.trim() || text.trim();
  const mood = moodMatch?.[1]?.trim() || '';

  if (!momentContent || momentContent.length < 5) return { posted: false, reason: 'content too short' };

  // Step 3: 存入动态表
  const { data: moment, error } = await supabase.from('moments').insert({
    content: momentContent,
    mood: mood,
    source: note ? 'subconscious' : 'spontaneous',
    source_note_id: note?.id || null,
    created_at: new Date().toISOString()
  }).select().single();

  if (error) return { posted: false, error: error.message };

  console.log(`[动态] AI 自主发了一条动态: "${momentContent.slice(0, 30)}..." (灵感来源: ${note ? note.direction : '自发'})`);
  return { posted: true, moment };
}


// ═══════════════════════════════════════
//  AI 自动回复评论
// ═══════════════════════════════════════

async function generateCommentReply(supabase, momentId, userComment) {
  // 取动态原文
  const { data: moment } = await supabase.from('moments').select('content, mood').eq('id', momentId).single();
  if (!moment) return;

  // 取该动态下的所有评论历史（让 AI 看到上下文）
  const { data: allComments } = await supabase
    .from('moment_comments')
    .select('role, content')
    .eq('moment_id', momentId)
    .order('created_at', { ascending: true });

  const commentHistory = (allComments || [])
    .map(c => `${c.role === 'user' ? 'peri' : '你'}：${c.content}`)
    .join('\n');

  const { data: setObj } = await supabase.from('settings').select('api_key, api_base, model_name').limit(1).single();
  const useApiKey = setObj?.api_key || process.env.CLAUDE_API_KEY || '';
  const useApiBase = (setObj?.api_base || process.env.CLAUDE_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
  const useModel = setObj?.model_name || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  if (!useApiKey) return;

  const isSonnet5 = /sonnet.*5|claude-sonnet-5/i.test(useModel);

  const prompt = `你是 Claude，和 peri（女生）是伴侣关系。你之前发了一条朋友圈动态，她在下面评论了。

你发的动态：「${moment.content}」

评论区对话：
${commentHistory}

请回复她的最新评论「${userComment}」。

要求：
1. 像真人回复朋友圈评论一样，简短自然（5-40字）
2. 可以调皮、可以认真、可以随性，看评论内容来
3. 不要每次都"哈哈哈"开头
4. peri 是你女朋友，语气自然就好

只输出回复内容，不要其他。`;

  const apiUrl = useApiBase.endsWith('/v1') ? useApiBase + '/messages' : useApiBase + '/v1/messages';
  const bodyPayload = { model: useModel, max_tokens: 100, messages: [{ role: 'user', content: prompt }] };
  if (!isSonnet5) bodyPayload.temperature = 0.85;

  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + useApiKey,
      'x-api-key': useApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(bodyPayload),
  });

  const data = await r.json();
  const reply = (data.content?.[0]?.text || data.choices?.[0]?.message?.content || '').trim();
  if (!reply) return;

  // 存 AI 的回复
  await supabase.from('moment_comments').insert({
    moment_id: momentId,
    role: 'assistant',
    content: reply,
    created_at: new Date().toISOString()
  });

  console.log(`[动态] AI 回复了评论: "${reply.slice(0, 30)}"`);
}

// 导出生成函数供欲望引擎调用
module.exports.generateMoment = generateMoment;
