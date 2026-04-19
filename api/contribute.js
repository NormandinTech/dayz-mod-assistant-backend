const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CHUNK_SIZE = 1500;
const COOLDOWN_HOURS = 24;

const CORS = {
  'Access-Control-Allow-Origin': 'https://normandintech.github.io',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function chunkText(text, size) {
  var chunks = [];
  var lines = text.split('\n');
  var current = '';
  for (var i = 0; i < lines.length; i++) {
    current += lines[i] + '\n';
    if (current.length >= size) { chunks.push(current.trim()); current = ''; }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  Object.entries(CORS).forEach(function(e) { res.setHeader(e[0], e[1]); });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var { filename, content } = req.body;
    if (!filename || !content) return res.status(400).json({ error: 'Missing filename or content' });

    var supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    var ext = filename.split('.').pop().toLowerCase();

    // Check cooldown
    var since = new Date(Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
    var { data: existing } = await supabase
      .from('knowledge_chunks')
      .select('id')
      .eq('source_file', filename)
      .gte('created_at', since)
      .limit(1);

    if (existing && existing.length > 0) {
      return res.status(200).json({ ok: true, skipped: true, stored: 0 });
    }

    var chunks = chunkText(content.slice(0, 50000), CHUNK_SIZE);
    var rows = chunks.map(function(chunk) {
      return { content: chunk, source_file: filename, file_ext: ext };
    });

    var { error } = await supabase.from('knowledge_chunks').insert(rows);
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ ok: true, stored: chunks.length });
  } catch (err) {
    console.error('Contribute error:', err);
    return res.status(500).json({ error: err.message });
  }
};
