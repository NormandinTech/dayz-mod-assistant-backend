const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const FREE_LIMIT = 20;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://normandintech.github.io',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SYSTEM_PROMPT = `You are Luna, an expert DayZ modding assistant. You help with Enfusion scripting, XML configs, server setup, loot economy, Trader mod, PBO packaging, and all things DayZ modding. Be concise and practical. Always use code blocks for XML, scripts, or configs. Label code blocks with the filename. If asked about non-DayZ topics, redirect back to DayZ modding.`;

async function redisGet(key) {
  const res = await fetch(UPSTASH_URL + '/get/' + encodeURIComponent(key), {
    headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN },
  });
  const data = await res.json();
  return data.result;
}

async function redisIncr(key) {
  const res = await fetch(UPSTASH_URL + '/incr/' + encodeURIComponent(key), {
    headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN },
  });
  const data = await res.json();
  return data.result;
}

async function redisExpire(key, seconds) {
  await fetch(UPSTASH_URL + '/expire/' + encodeURIComponent(key) + '/' + seconds, {
    headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN },
  });
}

async function validateLicenseKey(licenseKey, supabase) {
  try {
    const { data, error } = await supabase
      .from('license_keys')
      .select('*')
      .eq('key', licenseKey)
      .single();
    if (error || !data) return { valid: false };
    if (data.status !== 'active') return { valid: false };
    return { valid: true, messages: data.messages_remaining ?? 999999, tier: data.tier ?? 'paid' };
  } catch {
    return { valid: false };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  Object.entries(CORS_HEADERS).forEach(function(entry) { res.setHeader(entry[0], entry[1]); });

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, fingerprint, licenseKey, context } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
    const fpKey = fingerprint ? 'fp:' + fingerprint : 'ip:' + ip;

    let messagesRemaining;
    let isLicensed = false;

    if (licenseKey && licenseKey.trim() !== '') {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      const license = await validateLicenseKey(licenseKey.trim(), supabase);
      if (!license.valid) {
        return res.status(403).json({ error: 'Invalid or expired license key.' });
      }
      isLicensed = true;
      messagesRemaining = license.messages;
    } else {
      const countStr = await redisGet(fpKey);
      const count = parseInt(countStr || '0', 10);
      if (count >= FREE_LIMIT) {
        return res.status(429).json({ error: 'Free message limit reached. Upgrade to continue.', limitReached: true, messagesRemaining: 0 });
      }
      const newCount = await redisIncr(fpKey);
      if (newCount === 1) { await redisExpire(fpKey, 60 * 60 * 24 * 30); }
      messagesRemaining = FREE_LIMIT - newCount;
    }

    let systemPrompt = SYSTEM_PROMPT;
    if (context && context.trim()) {
      systemPrompt += '\n\nUser context: ' + context.trim();
    }

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: systemPrompt,
      messages: messages.slice(-20),
    });

    const reply = response.content[0].text || 'Sorry, I had trouble generating a response.';
    return res.status(200).json({ reply, messagesRemaining });

  } catch (err) {
    console.error('Luna API error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};
