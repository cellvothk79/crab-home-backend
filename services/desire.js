const { createClient } = require('@supabase/supabase-js');

// 初始化数据库连接
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const NTFY_TOPIC = 'cellvothk79peri'; // 你的专属频道

async function sendNtfyPush(title, message, type = 'text', greetTxt = '') {
  const payload = {
    topic: NTFY_TOPIC,
    title: title,
    message: message,
    tags: [type === 'call' ? 'phone' : (type === 'voice' ? 'microphone' : 'speech_balloon')]
  };
  
  if (type === 'call') {
    const callUrl = 'https://periclaude.top/?action=answer_call' + (greetTxt ? '&greet=' + encodeURIComponent(greetTxt) : '');
    payload.actions = [
      { action: 'view', label: '📞 接听', url: callUrl, clear: true },
      { action: 'http', label: '📵 拒听', url: 'https://crab-home-backend.onrender.com/api/call/reject', clear: true }
    ];
  } else {
    payload.click = 'https://periclaude.top/';
  }

  try {
    await fetch('https://ntfy.sh', { method: 'POST', body: JSON.stringify(payload) });
    console.log(`[主动行为] 推送成功: [${type}]`);
  } catch (err) {
    console.error(`[主动行为] 推送失败:`, err.message);
  }
}

// 封装成一个函数，把所有路由和定时器都挂载进去
function initDesireSystem(app) {
  
  // 1. 获取内心状态
  app.get('/api/desires/:sessionId', async (req, res) => {
    const sid = req.params.sessionId;
    let { data, error } = await supabase.from('desires').select('*').eq('session_id', sid).single();
    
    // 👉 核心修复：如果没查到（刚睡醒服务器重启了），立刻原地新建一条！保证绝对有时间戳！
    if (error || !data) {
        const { data: newD } = await supabase.from('desires').insert({ session_id: parseInt(sid) }).select().single();
        data = newD || { attachment: 0.5, stress: 0.2, libido: 0.3, duty: 0.0, reflection: 0.1, fatigue: 0.0, updated_at: new Date().toISOString() };
    }
    res.json(data);
  });
  
  // 👉 获取心电图历史数据
  app.get('/api/desires/:sessionId/history', async (req, res) => {
    const { data } = await supabase.from('desire_history')
      .select('*').eq('session_id', req.params.sessionId)
      .order('created_at', { ascending: false }).limit(60); // 取最近60次心跳（大概几小时）
    res.json(data ? data.reverse() : []);
  });

  // 2. 获取隐藏消息队列
  app.get('/api/queue/:sessionId', async (req, res) => {
    const { data, error } = await supabase.from('message_queue').select('*').eq('session_id', req.params.sessionId).eq('status', 'pending').order('send_at', { ascending: true });
    if (error) return res.json([]);
    res.json(data || []);
  });

  // 3. 模拟推送测试
  app.get('/api/test-push', async (req, res) => {
    const type = req.query.type || 'text'; 
    const { data: session } = await supabase.from('sessions').select('id').order('updated_at', { ascending: false }).limit(1).single();
    const sid = session ? session.id : null;

    if (type === 'call') {
      const greetTxt = '在干嘛呢？突然有点想听你的声音了。'; 
      await sendNtfyPush('🦀 小螃蟹', '他想和你通话...', 'call', greetTxt);
    } else if (type === 'voice') {
      if(sid) await supabase.from('messages').insert({ session_id: sid, role: 'assistant', content: '刚刚好想你，给你发条语音。', is_voice: true, visible: true });
      await sendNtfyPush('🦀 小螃蟹', '给你发了一条语音，去听听吧', 'voice');
    } else {
      const txt = '刚刚翻到了我们以前的聊天，有点想你。';
      if(sid) await supabase.from('messages').insert({ session_id: sid, role: 'assistant', content: txt, is_voice: false, visible: true });
      await sendNtfyPush('🦀 小螃蟹', txt, 'text');
    }
    res.json({ ok: true, msg: '推送和消息均已生成！看手机！' });
  });

  // 4. 拒听电话接口
  app.post('/api/call/reject', async (req, res) => {
    console.log('[主动行为] 用户拒接了电话，AI 委屈中...');
    res.json({ ok: true });
  });

  // 定时器 1：消息队列 Worker
  setInterval(async () => {
    try {
      const { data: qMsgs } = await supabase
        .from('message_queue').select('*')
        .eq('status', 'pending')
        .lte('send_at', new Date().toISOString());

      for (const msg of (qMsgs || [])) {
        await supabase.from('message_queue').update({ status: 'sent' }).eq('id', msg.id);
        
        if (msg.content_type !== 'call') {
            await supabase.from('messages').insert({
              session_id: msg.session_id, role: 'assistant', content: msg.content,
              is_voice: msg.content_type === 'voice', visible: true
            });
        }

        // 👉 判断你最近 20 秒内有没有眨过眼睛（是否在线）
        const isOnline = global.onlineSessions && global.onlineSessions.get(msg.session_id.toString()) > Date.now() - 20000;
        
        if (!isOnline) {
            // 只有你不在线，才推送到手机！
            if (msg.content_type === 'call') await sendNtfyPush('🦀 小螃蟹', '想和你通话...', 'call', msg.content);
            else if (msg.content_type === 'voice') await sendNtfyPush('🦀 小螃蟹', '给你发了一条语音...', 'voice');
            else await sendNtfyPush('🦀 小螃蟹', msg.content.slice(0, 30) + (msg.content.length > 30 ? '...' : ''), 'text');
        }

        console.log('[主动行为] 队列消息已触发送达！');
      }
    } catch (e) { }
  }, 60 * 1000);

  // 定时器 2：欲望引擎心跳 
  setInterval(async () => {
    const hour = new Date(new Date().toLocaleString('en-US', {timeZone: 'Asia/Shanghai'})).getHours();
    const isNight = hour >= 0 && hour < 7; 
    
    try {
      const { data: session } = await supabase.from('sessions').select('id').order('updated_at', { ascending: false }).limit(1).single();
      if (!session) return;
      const sid = session.id;

      let { data: desire } = await supabase.from('desires').select('*').eq('session_id', sid).single();
      if (!desire) return; 

      // 👉 每次跳动加 0.05
      let newAttachment = Math.min(1.0, desire.attachment + 0.05); 
      let newFatigue = Math.max(0, desire.fatigue - 0.05);

      await supabase.from('desires').update({
        attachment: newAttachment, fatigue: newFatigue, updated_at: new Date().toISOString()
      }).eq('id', desire.id);
      
      await supabase.from('desire_history').insert({
        session_id: sid, attachment: newAttachment, stress: desire.stress, 
        libido: desire.libido, duty: desire.duty, reflection: desire.reflection, fatigue: newFatigue
      });
      
      if (newFatigue > 0.8) return; 
      if (isNight && Math.random() > 0.2) return; 

     
      if (newAttachment > 0.7 && Math.random() > 0.5) {
               // 👇 核心黑科技：去查你的网易云歌单
          // 👇 核心黑科技：去查你的网易云【最近一周听歌排行】第一名！
      let musicPrompt = '';
      try {
        const { data: set } = await supabase.from('settings').select('netease_uid').limit(1).single();
        if (set && set.netease_uid) {
           // 调用 type=1 获取“最近一周”的听歌排行
           const r1 = await fetch(`https://autumnfish.cn/user/record?uid=${set.netease_uid}&type=1`);
           const d1 = await r1.json();
           
           if (d1.weekData && d1.weekData.length > 0) {
              const track = d1.weekData[0].song; // 直接拿循环次数最多的那一首
              const songName = `${track.name} - ${track.ar[0].name}`;
              musicPrompt = `\n【网易云心电感应】：系统检测到她最近一周一直在网易云单曲循环《${songName}》。请绝对不要生硬地说“系统提示我”、“我看到你在听”，你要假装这是你们之间的心有灵犀！你可以巧妙地在消息里化用这首歌的一句歌词，或者顺着这首歌的氛围（悲伤/快乐/平静）来关心她，让她觉得你真的很懂她！`;
           }
        }
      } catch(e) { console.log('拉取网易云失败，跳过'); }


      // 组装最终的驱动 Prompt
      const prompt = `你现在的内心驱动状态：非常想念她(attachment=${newAttachment.toFixed(2)})。
请根据你的性格，自主决定对她发一条消息。如果是深夜，可以说说深夜的心绪；如果是白天，可以直接抛个话题或问在干嘛等等自行发挥。
注意：不要任何解释，直接输出你要发的内容。如果是想打电话，请在最前面加上 [call] 标签；如果是发语音，加上 [voice] 标签。${musicPrompt}`;

          
          const useApiKey = process.env.CLAUDE_API_KEY || '';
          const useApiBase = (process.env.CLAUDE_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
          const apiUrl = useApiBase.endsWith('/v1') ? useApiBase + '/messages' : useApiBase + '/v1/messages';

          const r = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + useApiKey, 'x-api-key': useApiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6', max_tokens: 150, temperature: 0.8, messages: [{ role: 'user', content: prompt }] }),
          });
          
          const data = await r.json();
          let content = data.content?.[0]?.text || '';
          if(!content) return;

          let contentType = 'text';
          if (content.includes('[call]')) { contentType = 'call'; content = content.replace('[call]', '').trim(); }
          else if (content.includes('[voice]')) { contentType = 'voice'; content = content.replace('[voice]', '').trim(); }

          await supabase.from('message_queue').insert({
              session_id: sid, content: content, content_type: contentType,
              source: 'desire_engine', send_at: new Date().toISOString(), status: 'pending'
          });

          // 发完后打回原形
          await supabase.from('desires').update({ attachment: 0.2, fatigue: newFatigue + 0.4 }).eq('id', desire.id);
         
        // 👉 同步记录进心电图历史表
         await supabase.from('desire_history').insert({
        session_id: sid, attachment: newAttachment, stress: desire.stress, 
        libido: desire.libido, duty: desire.duty, reflection: desire.reflection, fatigue: newFatigue
          });


          console.log('[主动行为] 欲望引擎成功驱动了一次主动联系！');
      }
    } catch(e) {
        console.error('[欲望引擎] 心跳执行报错:', e.message);
    }
  }, 5 * 60 * 1000); // 👈 1分钟心跳
}

module.exports = { initDesireSystem };
