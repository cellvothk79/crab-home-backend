// ====== 潜意识便签系统 (Subconscious Notes) ======
// 需求文档 v11 第四章第4节：与欲望系统互补的偏好库
// 四步自驱动流水线：Observe → Select → Draw → Decide + 三层防重复衰减

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_BASE = (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');

// 偏好方向枚举
const DIRECTIONS = ['food', 'music', 'activity', 'movie', 'habit', 'emotion', 'place', 'style', 'topic', 'misc'];

// ====== Step 1: Observe（观测）======
// 在记忆提取后调用，从对话中发现新的偏好信号并自动创建便签
async function observeAndCreateNotes(userText, botReply) {
  if (!DEEPSEEK_API_KEY) return;
  if (!userText || userText.length > 2000 || userText.startsWith('以下是对话内容的简洁摘要')) return;

  try {
    const prompt = `你是一个偏好观测助手。分析下面这段对话，提取用户（peri）的偏好信号——她喜欢什么、不喜欢什么、想做什么、对什么感兴趣。

对话内容：
用户（peri）：${userText}
AI：${botReply}

请以 JSON 数组格式返回偏好条目，每条包含：
- direction: 偏好方向，只能是以下之一：food(食物饮品)、music(音乐)、activity(活动爱好)、movie(影视动漫)、habit(生活习惯)、emotion(情感触发点)、place(地点场景)、style(审美风格)、topic(话题兴趣)、misc(其他)
- content: 偏好内容，一句话描述（15-30字），从AI第一人称视角写，如"她最近迷上了某某"、"她不喜欢某某"
- strength: 偏好强度 0-1（随口提=0.3，明确表达喜欢=0.7，反复强调=1.0）

如果这段对话没有偏好信号，返回空数组 []。只返回JSON。`;

    const res = await fetch(DEEPSEEK_API_BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY },
      body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 500, temperature: 0.3, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || '[]';
    const clean = reply.replace(/```json|```/g, '').trim();
    let items = [];
    try {
      const parsed = JSON.parse(clean);
      items = Array.isArray(parsed) ? parsed : [];
    } catch (e) { return; }

    if (!items.length) return;

    for (const item of items) {
      if (!item.content || !item.direction) continue;
      if (!DIRECTIONS.includes(item.direction)) item.direction = 'misc';

      // 去重：查找是否已有相似便签（同方向 + 内容相似）
      const { data: existing } = await supabase
        .from('subconscious_notes')
        .select('id, content, weight')
        .eq('direction', item.direction)
        .limit(50);

      // 简单文本相似度去重（包含关系或字符重叠超过50%）
      let isDuplicate = false;
      if (existing && existing.length > 0) {
        for (const e of existing) {
          if (e.content.includes(item.content) || item.content.includes(e.content)) {
            isDuplicate = true;
            // 如果重复出现，增加权重（说明用户真的很在意这个偏好）
            await supabase.from('subconscious_notes').update({
              weight: Math.min((e.weight || 1.0) + 0.2, 3.0),
              updated_at: new Date().toISOString()
            }).eq('id', e.id);
            break;
          }
          // 关键词重叠检测
          const eWords = new Set(e.content.replace(/[，。！？、]/g, ' ').split(/\s+/).filter(w => w.length > 1));
          const iWords = new Set(item.content.replace(/[，。！？、]/g, ' ').split(/\s+/).filter(w => w.length > 1));
          let overlap = 0;
          for (const w of iWords) { if (eWords.has(w)) overlap++; }
          if (iWords.size > 0 && overlap / iWords.size > 0.5) {
            isDuplicate = true;
            await supabase.from('subconscious_notes').update({
              weight: Math.min((e.weight || 1.0) + 0.1, 3.0),
              updated_at: new Date().toISOString()
            }).eq('id', e.id);
            break;
          }
        }
      }

      if (!isDuplicate) {
        await supabase.from('subconscious_notes').insert({
          direction: item.direction,
          content: item.content,
          weight: 0.5 + (item.strength || 0.5) * 1.5,
          draw_count: 0,
          decay_level: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
        console.log(`[潜意识便签] 新建便签：[${item.direction}] ${item.content}`);
      }
    }
  } catch (err) {
    console.error('[潜意识便签] 观测失败:', err.message);
  }
}

// ====== Step 2+3: Select（选方向）+ Draw（抽便签）======
// 在欲望引擎心跳触发时调用，返回一个可用的便签（或null）
async function drawSubconsciousNote() {
  try {
    // 三层防重复衰减时间窗口
    const now = Date.now();
    const COOLDOWN = {
      0: 0,                          // decay_level 0：新鲜，不冷却
      1: 3 * 60 * 60 * 1000,         // decay_level 1：3小时冷却
      2: 24 * 60 * 60 * 1000,        // decay_level 2：24小时冷却
      3: 72 * 60 * 60 * 1000,        // decay_level 3+：72小时冷却
    };

    // Step 2: Select — 随机选一个方向
    const direction = DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];

    // 先尝试指定方向，如果该方向没有可用便签，再从全量中抽
    let candidates = await getAvailableNotes(direction, now, COOLDOWN);
    if (candidates.length === 0) {
      // 该方向没有可用的，从所有方向中找
      candidates = await getAvailableNotes(null, now, COOLDOWN);
    }
    if (candidates.length === 0) return null;

    // Step 3: Draw — 加权随机抽取（权重高的更容易被抽中）
    const totalWeight = candidates.reduce((sum, n) => sum + (n.weight || 1), 0);
    let rand = Math.random() * totalWeight;
    let picked = candidates[0];
    for (const c of candidates) {
      rand -= (c.weight || 1);
      if (rand <= 0) { picked = c; break; }
    }

    // 更新抽取状态
    const newDrawCount = (picked.draw_count || 0) + 1;
    const newDecayLevel = Math.min(newDrawCount, 3); // 上限3
    await supabase.from('subconscious_notes').update({
      last_drawn_at: new Date().toISOString(),
      draw_count: newDrawCount,
      decay_level: newDecayLevel,
      updated_at: new Date().toISOString()
    }).eq('id', picked.id);

    console.log(`[潜意识便签] 抽中便签：[${picked.direction}] ${picked.content} (衰减等级→${newDecayLevel})`);
    return picked;
  } catch (err) {
    console.error('[潜意识便签] 抽取失败:', err.message);
    return null;
  }
}

// 获取可用（未冷却）的便签
async function getAvailableNotes(direction, now, COOLDOWN) {
  try {
    let query = supabase
      .from('subconscious_notes')
      .select('*')
      .order('weight', { ascending: false })
      .limit(100);

    if (direction) query = query.eq('direction', direction);

    const { data, error } = await query;
    if (error || !data) return [];

    // 过滤掉冷却中的便签
    return data.filter(n => {
      if (!n.last_drawn_at) return true; // 从没被抽过，直接可用
      const lastDrawn = new Date(n.last_drawn_at).getTime();
      const cooldown = COOLDOWN[Math.min(n.decay_level || 0, 3)] || 0;
      return (now - lastDrawn) > cooldown;
    });
  } catch (err) {
    return [];
  }
}

// ====== 格式化便签为 prompt 注入内容 ======
function formatNoteForPrompt(note) {
  if (!note) return '';
  const directionLabels = {
    food: '食物', music: '音乐', activity: '活动', movie: '影视',
    habit: '习惯', emotion: '情感', place: '地方', style: '审美',
    topic: '话题', misc: '杂事'
  };
  const label = directionLabels[note.direction] || '偏好';
  return `\n【潜意识便签·${label}】你此刻脑海中浮现了一个关于她的细节——"${note.content}"。这不是指令，只是你潜意识里的一个念头，你可以选择自然地融入对话，也可以忽略它。\n`;
}

module.exports = { observeAndCreateNotes, drawSubconsciousNote, formatNoteForPrompt };
