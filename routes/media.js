module.exports = function(app, supabase) {
  
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

  // 👉 核心黑科技：穿上防弹伪装衣，集成 豆瓣 + 苹果 + B站 终极搜图！
  app.get('/api/media/cover', async (req, res) => {
    const { title, type } = req.query;
    if (!title) return res.json({ url: '' });

    // 👇 就是这件“伪装衣”：假装自己是一台真实的 Mac 电脑和 Chrome 浏览器！
    const headers = { 
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/json,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };

    try {
      // 1. 先去抓“豆瓣”的海报 (最精准，穿上伪装衣后成功率极高)
      try {
        const dbRes = await fetch(`https://www.douban.com/search?q=${encodeURIComponent(title)}`, { headers });
        const dbHtml = await dbRes.text();
        const dbMatch = dbHtml.match(/src="(https:\/\/img\d\.doubanio\.com\/view\/photo\/s_ratio_poster\/public\/[^"]+)"/);
        if (dbMatch && dbMatch[1]) return res.json({ url: dbMatch[1] });
      } catch(e) {}

      // 2. 如果豆瓣没搜到，电影用苹果官方库
      if (type === 'movie') {
        try {
          const itunesRes = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(title)}&entity=movie&country=cn&limit=1`, { headers });
          const itData = await itunesRes.json();
          if (itData.results && itData.results[0]?.artworkUrl100) {
            return res.json({ url: itData.results[0].artworkUrl100.replace('100x100bb', '600x900bb') }); // 换成高清大图
          }
        } catch(e) {}
      }

      // 3. 游戏或上面的都失败了，启动 B站 (Bilibili) 官方搜索 API！绝不拦截！
      try {
        const biliRes = await fetch(`https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(title)}`, { headers });
        const biliData = await biliRes.json();
        if (biliData?.data?.result) {
          const media = biliData.data.result.find(r => r.result_type === 'media_ft' || r.result_type === 'media_bangumi'); // 找影视番剧
          if (media?.data?.[0]?.cover) return res.json({ url: media.data[0].cover.startsWith('http') ? media.data[0].cover : 'https:' + media.data[0].cover });
          const video = biliData.data.result.find(r => r.result_type === 'video'); // 找游戏解说封面
          if (video?.data?.[0]?.pic) return res.json({ url: video.data[0].pic.startsWith('http') ? video.data[0].pic : 'https:' + video.data[0].pic });
        }
      } catch(e) {}

      res.json({ url: '' });
    } catch(e) {
      res.json({ url: '' });
    }
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
