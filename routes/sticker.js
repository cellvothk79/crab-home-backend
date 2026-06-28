const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 限制 5MB

module.exports = function(app, supabase) {
  
  // 1. 获取所有表情包
  app.get('/api/stickers', async (req, res) => {
    const { data, error } = await supabase.from('stickers').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // 2. 上传新表情包
  app.post('/api/stickers', upload.single('file'), async (req, res) => {
    const { sticker_id, desc } = req.body;
    if (!req.file || !sticker_id || !desc) return res.status(400).json({ error: '参数不全' });

    try {
      // 传图片到 Storage
      const fileName = `sticker_${Date.now()}_${Math.floor(Math.random()*1000)}.png`;
      const { error: uploadErr } = await supabase.storage.from('stickers').upload(fileName, req.file.buffer, { contentType: req.file.mimetype || 'image/png' });
      if (uploadErr) throw new Error('上传图片失败');

      const { data: urlData } = supabase.storage.from('stickers').getPublicUrl(fileName);

      // 写数据库
      const { data, error: dbErr } = await supabase.from('stickers').insert({
        sticker_id, "desc": desc, image_url: urlData.publicUrl
      }).select().single();
      
      if (dbErr) throw new Error(dbErr.message);
      res.json({ ok: true, data });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 3. 删除表情包
  app.delete('/api/stickers/:id', async (req, res) => {
    await supabase.from('stickers').delete().eq('id', req.params.id);
    res.json({ ok: true });
  });

};
