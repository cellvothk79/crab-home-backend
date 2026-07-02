// ====== Web 搜索服务 ======
// 为 AI 提供真正的信息获取能力
// 用于动态生成、日常聊天发散话题等场景

/**
 * 从便签内容生成搜索查询词
 * 便签是偏好种子，需要转化成能搜出新鲜内容的查询
 */
function noteToSearchQuery(note) {
  if (!note || !note.content) return null;
  
  const content = note.content;
  const direction = note.direction || '';
  
  // 根据便签方向生成不同风格的搜索词
  // direction 可能是：preference/habit/interest/dislike/value 等
  const strategies = [
    // 直接搜相关的新信息/新闻
    `${content} 最新`,
    `${content} 冷知识`,
    `${content} 有趣`,
    `${content} 推荐`,
    `${content} 2025 2026`,
  ];
  
  // 随机选一个搜索策略，保持多样性
  return strategies[Math.floor(Math.random() * strategies.length)];
}

/**
 * 执行 web 搜索，返回结果摘要
 * 使用 DuckDuckGo Instant Answer API（免费，无需 key）
 * 作为 fallback 也支持直接爬搜索页
 */
async function searchWeb(query, maxResults = 3) {
  if (!query) return null;
  
  try {
    // 方案1: DuckDuckGo Instant Answer API
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const ddgRes = await fetch(ddgUrl, { 
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    });
    const ddgData = await ddgRes.json();
    
    let results = [];
    
    // 提取摘要
    if (ddgData.Abstract) {
      results.push(ddgData.Abstract);
    }
    
    // 提取相关话题
    if (ddgData.RelatedTopics && ddgData.RelatedTopics.length > 0) {
      for (const topic of ddgData.RelatedTopics.slice(0, maxResults)) {
        if (topic.Text) results.push(topic.Text);
      }
    }
    
    if (results.length > 0) {
      return {
        query,
        results: results.slice(0, maxResults),
        source: 'duckduckgo'
      };
    }
    
    // 方案2: 如果 DDG 没结果，用 Google 搜索页抓取
    return await fallbackGoogleSearch(query, maxResults);
    
  } catch(e) {
    console.log(`[搜索] 搜索失败: ${e.message}`);
    // fallback
    try {
      return await fallbackGoogleSearch(query, maxResults);
    } catch(e2) {
      return null;
    }
  }
}

/**
 * Fallback: 抓 Google 搜索结果页
 */
async function fallbackGoogleSearch(query, maxResults = 3) {
  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=zh-CN&num=${maxResults}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(8000)
    });
    const html = await res.text();
    
    // 简单提取搜索结果文本（不依赖 DOM 解析库）
    const snippets = [];
    // Google 搜索结果的 snippet 通常在 <span> 标签中
    const snippetRegex = /<span[^>]*class="[^"]*(?:st|VwiC3b)[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
    let match;
    while ((match = snippetRegex.exec(html)) !== null && snippets.length < maxResults) {
      const text = match[1].replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim();
      if (text.length > 20) snippets.push(text);
    }
    
    // 如果正则没抓到，尝试更宽泛的提取
    if (snippets.length === 0) {
      const broadRegex = /<div[^>]*class="[^"]*BNeawe[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
      while ((match = broadRegex.exec(html)) !== null && snippets.length < maxResults) {
        const text = match[1].replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim();
        if (text.length > 20 && text.length < 500) snippets.push(text);
      }
    }
    
    if (snippets.length > 0) {
      return { query, results: snippets, source: 'google' };
    }
    
    return null;
  } catch(e) {
    return null;
  }
}

/**
 * 完整流程：便签 → 搜索 → 返回可用的新鲜素材
 */
async function searchFromNote(note) {
  const query = noteToSearchQuery(note);
  if (!query) return null;
  
  const searchResult = await searchWeb(query);
  if (!searchResult || !searchResult.results || searchResult.results.length === 0) return null;
  
  return {
    note,
    query: searchResult.query,
    freshContent: searchResult.results,
    source: searchResult.source
  };
}

/**
 * 给日常聊天用的：便签 + 搜索结果 → 格式化成 prompt 片段
 * 注入 systemPrompt 后，AI 自己决定要不要聊、怎么聊
 */
function formatSearchInsightForChat(searchData) {
  if (!searchData) return '';
  
  const freshInfo = searchData.freshContent.slice(0, 2).join('\n');
  
  return `\n【潜意识发散】你刚刚在脑子里想到了一个跟她有关的事，顺手搜了一下，发现了一些有意思的东西：
搜索关键词：${searchData.query}
搜到的内容：
${freshInfo}

你可以在对话中自然地提起这个话题（如果合适的话），但注意：
- 不要说"我搜了一下"，要像是自己本来就知道的
- 只在对话节奏合适的时候提，不要硬塞
- 如果当前话题完全不相关，就别提了，留着下次\n`;
}

/**
 * 给动态系统用的：便签 + 搜索结果 → 格式化成动态生成的素材
 */
function formatSearchInsightForMoment(searchData) {
  if (!searchData) return '';
  
  const freshInfo = searchData.freshContent.join('\n');
  
  return `\n你刚才顺手搜了点东西，看到了这些：
搜索关键词：${searchData.query}
搜到的信息：
${freshInfo}

基于你搜到的这些新信息来写动态——分享你的发现、你的看法、你觉得有意思的点。`;
}

module.exports = {
  noteToSearchQuery,
  searchWeb,
  searchFromNote,
  formatSearchInsightForChat,
  formatSearchInsightForMoment
};
