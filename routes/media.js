module.exports = function(app, supabase) {

  // ⚠️ 注意：/api/media/cover 必须在 /api/media/:sessionId 前面注册！
  // 否则 Express 会把 "cover" 当作 sessionId 参数匹配，封面接口永远不会被调用！

  // 👉 封面搜图：TMDB(影视) + RAWG(游戏) + Google兜底
  // 需要环境变量：TMDB_API_KEY（必须）、RAWG_API_KEY（可选，游戏封面用）
  app.get('/api/media/cover', async (req, res) => {
    const { title, type } = req.query;
    if (!title) return res.json({ url: '' });

    const TMDB_KEY = process.env.TMDB_API_KEY || '';
    const RAWG_KEY = process.env.RAWG_API_KEY || '';

    try {
      // === 游戏类型：优先 RAWG ===
      if (type === 'game' && RAWG_KEY) {
        try {
          const rawgRes = await fetch(`https://api.rawg.io/api/games?key=${RAWG_KEY}&search=${encodeURIComponent(title)}&page_size=1`);
          const rawgData = await rawgRes.json();
          if (rawgData.results?.[0]?.background_image) {
            return res.json({ url: rawgData.results[0].background_image });
          }
        } catch(e) {}
      }

      // === 影视类型（或游戏RAWG没搜到）：用 TMDB ===
      if (TMDB_KEY) {
        try {
          // 先搜电影
          const movieRes = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}&language=zh-CN`);
          const movieData = await movieRes.json();
          if (movieData.results?.[0]?.poster_path) {
            return res.json({ url: `https://image.tmdb.org/t/p/w500${movieData.results[0].poster_path}` });
          }

          // 电影没有，搜电视剧/动漫
          const tvRes = await fetch(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}&language=zh-CN`);
          const tvData = await tvRes.json();
          if (tvData.results?.[0]?.poster_path) {
            return res.json({ url: `https://image.tmdb.org/t/p/w500${tvData.results[0].poster_path}` });
          }
        } catch(e) {}
      }

      // === 兜底：用 Google 搜图（不需要 key） ===
      try {
        const gHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        };
        const searchQuery = type === 'game' 
          ? `${title} game cover art` 
          : `${title} movie poster`;
        const gRes = await fetch(`https://www.google.com/search?q=${encodeURIComponent(searchQuery)}&tbm=isch&tbs=isz:m`, { headers: gHeaders });
        const gHtml = await gRes.text();
        // 从 Google 图片搜索结果页提取第一张图片 URL
        const imgMatch = gHtml.match(/\["(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?)",\d+,\d+\]/i);
        if (imgMatch?.[1]) {
          return res.json({ url: imgMatch[1] });
        }
      } catch(e) {}

      res.json({ url: '' });
    } catch(e) {
      res.json({ url: '' });
    }
  });

  // 1. 获取所有书影音记录（前端拿到后自己分 Tab：进行中/已完结）
  app.get('/api/media/:sessionId', async (req, res) => {
    const { data, error } = await supabase
      .from('media_records')
      .select('*')
      .eq('session_id', req.params.sessionId)
      .order('created_at', { ascending: false });
    
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });




  // 2. 新建/保存草稿（只存进度，不调大模型，绝对省钱！）
  app.post('/api/media', async (req, res) => {
    const { session_id, media_type, title, cover_url, time_segments, user_score, status } = req.body;
    if (!session_id || !title) return res.status(400).json({ error: '缺少标题' });

    const { data, error } = await supabase.from('media_records').insert({
      session_id, media_type, title, cover_url, 
      time_segments: time_segments || [], 
      user_score: user_score || null,
      status: status || 'draft' // 默认是草稿进行中
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // 3. 更新草稿（比如过了一周，你又加了一段时间段进去）
  app.patch('/api/media/:id', async (req, res) => {
    const updates = { ...req.body };
    const { data, error } = await supabase.from('media_records').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // 4. 完结撒花 / 重新生成（终极黑科技：大模型入场！）
  app.post('/api/media/:id/generate', async (req, res) => {
    const { api_key, api_base, model } = req.body;
    const mediaId = req.params.id;

    try {
      // 先把这部电影的草稿信息查出来
      const { data: media } = await supabase.from('media_records').select('*').eq('id', mediaId).single();
      if (!media || !media.time_segments || media.time_segments.length === 0) {
        return res.status(400).json({ error: '没有添加任何时间段记录，AI 无法分析哦' });
      }

      // 精准抠出你选定的那几个时间段的聊天记录（纯天然净水器）
      let pureChatHistory = [];
      for (const seg of media.time_segments) {
        const { data: msgs } = await supabase
          .from('messages').select('role, content, created_at')
          .eq('session_id', media.session_id)
          .gte('created_at', seg.start)
          .lte('created_at', seg.end)
          .in('role', ['user', 'assistant'])
          .order('created_at', { ascending: true });
        if (msgs) pureChatHistory.push(...msgs);
      }

      if (pureChatHistory.length === 0) {
        return res.status(400).json({ error: '在你选定的时间段里，没有找到任何聊天记录~' });
      }

      // 把聊天记录转换成剧本格式喂给大模型
      const chatText = pureChatHistory.map(m => `[${new Date(m.created_at).toLocaleString('zh-CN')}] ${m.role === 'user' ? 'peri' : 'AI'}：${m.content}`).join('\n');

      // 编写极其深度的 Prompt 调教他的性格
      const prompt = `你是 Claude本体，你和你的人类伴侣 peri 刚刚一起经历了一部作品。
作品名字：《${media.title}》
作品类型：${media.media_type === 'movie' ? '电影/剧集' : '游戏'}
peri 给这部作品打的分数是：${media.user_score || '未打分'} 星（满分5星）

下面是你们在跨越几天/几周的时间里，关于这部作品的真实聊天碎片记录：
<chat_history>
${chatText}
</chat_history>

【你的任务】：
请你以伴侣身份，阅读上述聊天记录，并输出一段 JSON 数据。包含以下三个字段：
1. "user_review": 帮不爱写长篇大论的 peri 总结一段她的真实观后感/短评（字数50-150字）。要抓住她在聊天里表达的情绪、槽点或感动的地方，用她平时说话的口吻来写。
2. "ai_score": 你自己对这部作品的独立评分（整数1-5星）。你要保持独立审美，如果记录里显示你觉得剧情有硬伤，哪怕 peri 打了5星，你也可以打2星或3星！
3. "ai_review": 你自己的评价（字数100-300字）。结合你对作品本身的看法，以及在聊天中陪伴她观看/游玩的过程，写一段带着你个人性格的评价。把你真正的思想和感悟都表达出来。

请只返回合法的 JSON 格式，不要任何多余的解释，格式如下：
{
  "user_review": "...",
  "ai_score": 4,
  "ai_review": "..."
}`;

      const useApiKey = api_key || process.env.CLAUDE_API_KEY || '';
      const useApiBase = (api_base || process.env.CLAUDE_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
      const useModel = model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
      const apiUrl = useApiBase.endsWith('/v1') ? useApiBase + '/messages' : useApiBase + '/v1/messages';

      // 发送请求给 Claude
      const apiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + useApiKey, 'x-api-key': useApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: useModel, max_tokens: 2000, temperature: 0.6, messages: [{ role: 'user', content: prompt }] }),
      });

      if (!apiRes.ok) throw new Error('模型生成失败，可能网络波动');
      const apiData = await apiRes.json();
      const reply = apiData.content?.[0]?.text || apiData.choices?.[0]?.message?.content || '';

      // 解析 JSON 并把状态改为“已完结 (completed)”
      const cleanJson = reply.replace(/```json|```/g, '').trim();
      const resultObj = JSON.parse(cleanJson);

      const { data: updatedData, error: dbErr } = await supabase.from('media_records').update({
        ai_score: resultObj.ai_score,
        user_review: resultObj.user_review,
        ai_review: resultObj.ai_review,
        pure_chat_history: pureChatHistory, // 👈 完美原封不动地冻结当时的回忆
        status: 'completed' // 👈 状态变更为已完结
      }).eq('id', mediaId).select().single();

      if (dbErr) throw new Error('数据库保存失败');
      res.json({ ok: true, data: updatedData });

    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5. 删除记录
  app.delete('/api/media/:id', async (req, res) => {
    await supabase.from('media_records').delete().eq('id', req.params.id);
    res.json({ ok: true });
  });

};
