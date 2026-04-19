const Anthropic = require('@anthropic-ai/sdk');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FREE_LIMIT = 20;

const CORS = {
  'Access-Control-Allow-Origin': 'https://normandintech.github.io',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SYSTEM_PROMPT = `You are Luna, an expert DayZ modding assistant. You help with Enfusion scripting, XML configs (types.xml, events.xml, mapgroupproto.xml, cfgspawnabletypes.xml, globals.xml), server setup, loot economy, Trader mod, PBO packaging, Workbench, and all things DayZ modding. Be concise and practical. Always use code blocks for XML, scripts, or configs labeled with the filename.`;

async function redisGet(key){
  try{
    const r=await fetch(UPSTASH_URL+'/get/'+encodeURIComponent(key),{headers:{Authorization:'Bearer '+UPSTASH_TOKEN}});
    const d=await r.json();return d.result;
  }catch{return null;}
}
async function redisIncr(key){
  try{
    const r=await fetch(UPSTASH_URL+'/incr/'+encodeURIComponent(key),{headers:{Authorization:'Bearer '+UPSTASH_TOKEN}});
    const d=await r.json();return d.result;
  }catch{return null;}
}
async function redisExpire(key,seconds){
  try{await fetch(UPSTASH_URL+'/expire/'+encodeURIComponent(key)+'/'+seconds,{headers:{Authorization:'Bearer '+UPSTASH_TOKEN}});}catch{}
}

module.exports = async function handler(req, res) {
  if(req.method==='OPTIONS'){res.writeHead(204,CORS);return res.end();}
  Object.entries(CORS).forEach(function(e){res.setHeader(e[0],e[1]);});
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});

  try{
    const {messages,fingerprint,licenseKey,context}=req.body;
    if(!messages||!Array.isArray(messages))return res.status(400).json({error:'Invalid request'});

    const ip=(req.headers['x-forwarded-for']||'unknown').split(',')[0].trim();
    const fpKey=fingerprint?'fp:'+fingerprint:'ip:'+ip;

    // Rate limiting — free tier only (skip if license key provided)
    if(!licenseKey||licenseKey.trim()===''){
      const countStr=await redisGet(fpKey);
      const count=parseInt(countStr||'0',10);
      if(count>=FREE_LIMIT){
        res.writeHead(200,Object.assign({'Content-Type':'text/event-stream','Cache-Control':'no-cache'},CORS));
        res.write('data: '+JSON.stringify({code:'LIMIT_REACHED'})+'\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const newCount=await redisIncr(fpKey);
      if(newCount===1)await redisExpire(fpKey,60*60*24*30);
      // Send usage info
    }

    let systemPrompt=SYSTEM_PROMPT;
    if(context&&context.trim())systemPrompt+='\n\nUser context: '+context.trim();

    const anthropic=new Anthropic({apiKey:ANTHROPIC_API_KEY});

    res.writeHead(200,Object.assign({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'},CORS));

    const stream=await anthropic.messages.stream({
      model:'claude-sonnet-4-20250514',
      max_tokens:1500,
      system:systemPrompt,
      messages:messages.slice(-20),
    });

    for await(const chunk of stream){
      if(chunk.type==='content_block_delta'&&chunk.delta.type==='text_delta'){
        res.write('data: '+JSON.stringify({text:chunk.delta.text})+'\n\n');
      }
    }

    const final=await stream.finalMessage();
    const remaining=FREE_LIMIT-(parseInt((await redisGet(fpKey))||'0',10));
    res.write('data: '+JSON.stringify({usage:{type:'free',remaining:Math.max(0,remaining)}})+'\n\n');
    res.write('data: [DONE]\n\n');
    res.end();

  }catch(err){
    console.error('Luna error:',err);
    try{
      res.write('data: '+JSON.stringify({error:err.message})+'\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }catch{}
  }
};
