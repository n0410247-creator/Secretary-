import base64, hashlib, hmac, json, logging, os, secrets as pysecrets, sqlite3, time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Optional

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, Request, HTTPException, Depends, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

ROOT = Path(os.getenv('DATA_DIR', './data')).resolve(); ROOT.mkdir(parents=True, exist_ok=True)
AUDIO = ROOT / 'audio'; AUDIO.mkdir(exist_ok=True)
DB = ROOT / 'victor.sqlite3'
APP_PIN = os.getenv('APP_PIN', '').strip()
CORS_ORIGINS = [x.strip() for x in os.getenv('CORS_ORIGINS','https://localhost').split(',') if x.strip()]
PUBLIC_URL = os.getenv('PUBLIC_URL','').rstrip('/')
MAX_BODY = int(os.getenv('MAX_BODY_BYTES','12582912'))
RATE_LIMIT = int(os.getenv('RATE_LIMIT_PER_MINUTE','60'))
log = logging.getLogger('victor'); logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

DEFAULT_SETTINGS = {
 'providers': {'primary':os.getenv('AI_PROVIDER','gonka'),'fallback':os.getenv('FALLBACK_PROVIDER','gemini'),'fallbackEnabled':os.getenv('ENABLE_PROVIDER_FALLBACK','false').lower()=='true',
   'gemini':{'model':os.getenv('GEMINI_MODEL','gemini-2.0-flash'),'temperature':0.7,'maxOutputTokens':1024},
   'gonka':{'baseUrl':os.getenv('GONKA_BASE_URL',os.getenv('OPENAI_COMPAT_BASE_URL','https://api.gonkarouter.io/v1')),'apiFormat':'openai','model':os.getenv('GONKA_MODEL',os.getenv('OPENAI_COMPAT_MODEL','MiniMaxAI/MiniMax-M2.7'))},
   'compatible':{'baseUrl':os.getenv('OPENAI_COMPAT_BASE_URL','https://api.gonkarouter.io/v1'),'apiFormat':'openai','model':os.getenv('OPENAI_COMPAT_MODEL','MiniMaxAI/MiniMax-M2.7')},
   'huggingface':{'enabled':bool(os.getenv('HUGGINGFACE_TOKEN')),'model':os.getenv('HUGGINGFACE_MODEL','')}},
 'voice': {'sttEngine':'server','sttLanguage':'en-US','sttModel':os.getenv('GEMINI_STT_MODEL','gemini-2.0-flash'),
   'ttsEngine':'auto','ttsModel':os.getenv('GEMINI_TTS_MODEL','gemini-2.5-flash-preview-tts'),'ttsVoice':os.getenv('GEMINI_TTS_VOICE','Kore'),'ttsStyle':''},
 'whatsapp': {'phoneNumberId':os.getenv('WHATSAPP_PHONE_NUMBER_ID',''),'wabaId':'','graphVersion':os.getenv('WHATSAPP_GRAPH_VERSION','v23.0'),
   'autoReplyEnabled':os.getenv('WHATSAPP_AUTO_REPLY','false').lower()=='true','awayModeEnabled':False,'awayModeSchedule':{'mode':'off','start':'09:00','end':'17:00'},
   'handleVoiceNotes':True,'transcribeVoiceNotes':True,'summarizeVoiceNotes':True,'flagImportant':True,'notifyOwner':False,'ownerWaId':'','maxRetries':3,
   'callingEnabled':False,'callingAnswerMode':'disabled','callingGreeting':'Hello, I am VICTOR AI.','callingMaxSeconds':300,'callingMaxTurns':20,'callingRecordAudio':False},
 'privacy': {'retentionDays':30,'keepAudio':True}, 'server': {}
}

def now(): return datetime.now(timezone.utc).isoformat()
def db():
 c=sqlite3.connect(DB); c.row_factory=sqlite3.Row; c.execute('PRAGMA foreign_keys=ON'); return c

def init_db():
 c=db(); schema=Path(__file__).resolve().parents[1]/'schema.sql'; c.executescript(schema.read_text());
 if not c.execute('select 1 from settings where id=1').fetchone(): c.execute('insert into settings values(1,?,?)',(json.dumps(DEFAULT_SETTINGS),now()))
 c.commit(); c.close()
init_db()

def setting():
 c=db(); row=c.execute('select value_json from settings where id=1').fetchone(); c.close();
 stored=json.loads(row['value_json'])
 return merge(json.loads(json.dumps(DEFAULT_SETTINGS)),stored)
def merge(a,b):
 for k,v in b.items():
  if isinstance(v,dict) and isinstance(a.get(k),dict): merge(a[k],v)
  else: a[k]=v
 return a
def save_setting(patch):
 s=merge(setting(),patch); c=db(); c.execute('update settings set value_json=?,updated_at=? where id=1',(json.dumps(s),now())); c.commit(); c.close(); return s
def activity(kind, detail):
 c=db(); c.execute('insert into activity(kind,detail_json,created_at) values(?,?,?)',(kind,json.dumps(detail)[:20000],now())); c.commit(); c.close()

def cipher():
 raw=os.getenv('SECRET_ENCRYPTION_KEY','').strip()
 if not raw: return None
 try:
  key=base64.urlsafe_b64decode(raw + '='*((4-len(raw)%4)%4))
  if len(key)!=32: raise ValueError
  return key
 except Exception: raise HTTPException(503,'SECRET_ENCRYPTION_KEY must be a valid Fernet-compatible 32-byte base64 key.')
def encrypt(v):
 key=cipher()
 if not key: raise HTTPException(503,'Secret storage is disabled: configure SECRET_ENCRYPTION_KEY on the server.')
 nonce=pysecrets.token_bytes(12); return base64.b64encode(nonce+AESGCM(key).encrypt(nonce,v.encode(),None)).decode()
def decrypt(v):
 key=cipher()
 if not key: return None
 b=base64.b64decode(v); return AESGCM(key).decrypt(b[:12],b[12:],None).decode()
def secret(name):
 c=db(); r=c.execute('select ciphertext from secrets where name=?',(name,)).fetchone(); c.close()
 if r:
  try:return decrypt(r['ciphertext'])
  except Exception: return None
 return {'gemini.apiKey':os.getenv('GEMINI_API_KEY'),'gonka.apiKey':os.getenv('GONKA_API_KEY'),'huggingface.token':os.getenv('HUGGINGFACE_TOKEN'),'whatsapp.accessToken':os.getenv('WHATSAPP_ACCESS_TOKEN'),'whatsapp.appSecret':os.getenv('WHATSAPP_APP_SECRET')}.get(name)

def masked(v):
 preview=(v[:4]+'…'+v[-4:]) if v and len(v)>8 else ('••••' if v else '')
 fingerprint=hashlib.sha256(v.encode()).hexdigest()[:12] if v else ''
 return {'set':bool(v),'preview':preview,'masked':preview,'fingerprint':fingerprint}
def credential_status(name):
 c=db(); row=c.execute('select ciphertext from secrets where name=?',(name,)).fetchone(); c.close()
 if row:
  try:
   value=decrypt(row['ciphertext'])
   return dict(masked(value),decryptable=bool(value))
  except Exception:
   return {'set':True,'decryptable':False,'preview':'','masked':'','fingerprint':''}
 return dict(masked(secret(name)),decryptable=True)
def public_settings():
 s=setting(); s['server']={'env':os.getenv('APP_ENV','development'),'appPinSet':bool(APP_PIN),'publicUrl':PUBLIC_URL,'webhookPath':'/webhooks/whatsapp','callingMediaSupported':False,'callingMediaReason':'No supported WhatsApp live-media WebRTC stack is configured in this deployment.'}
 s['secrets']={k:credential_status(k) for k in ['gemini.apiKey','gonka.apiKey','huggingface.token','whatsapp.accessToken','whatsapp.appSecret']}
 return s

class ChatIn(BaseModel): message:str=Field(min_length=1,max_length=20000); sessionId:Optional[str]=None
class SummaryIn(BaseModel): text:str=Field(min_length=1,max_length=50000); kind:Optional[str]='general'
class SecretIn(BaseModel): value:str=Field(min_length=1,max_length=4096)
class VoiceIn(BaseModel): audioBase64:str=Field(min_length=1,max_length=MAX_BODY); mimeType:str='audio/webm'
class SpeakIn(BaseModel): text:str=Field(min_length=1,max_length=5000); voice:Optional[str]=None; format:Optional[str]='base64'
class AuthIn(BaseModel): pin:str=Field(min_length=1,max_length=256)

app=FastAPI(title='VICTOR AI Backend',version='1.0.1')
app.add_middleware(CORSMiddleware,allow_origins=CORS_ORIGINS,allow_credentials=True,allow_methods=['GET','POST','PUT','DELETE','OPTIONS'],allow_headers=['*'])

@app.middleware('http')
async def limits(request:Request, call_next):
 if request.headers.get('content-length') and int(request.headers['content-length'])>MAX_BODY: return Response('Request too large',status_code=413)
 ip=request.client.host if request.client else 'unknown'; key=f'{ip}:{int(time.time()//60)}'; request.app.state.rl=getattr(request.app.state,'rl',{})
 if key not in request.app.state.rl: request.app.state.rl[key]=0
 request.app.state.rl[key]+=1
 if request.app.state.rl[key]>RATE_LIMIT: return Response('Rate limit exceeded',status_code=429)
 return await call_next(request)

def authorized(request:Request, x_victor_pin:Optional[str]=Header(None)):
 if not APP_PIN: raise HTTPException(503,'APP_PIN is not configured. Set a strong server PIN before using protected routes.')
 supplied=x_victor_pin or request.cookies.get('victor_session','')
 if not supplied or not hmac.compare_digest(supplied,APP_PIN): raise HTTPException(401,'Not authorized.',headers={'WWW-Authenticate':'Victor-Pin'})
 return True

def safe_error(e):
 if isinstance(e,httpx.TimeoutException): return 'Provider request timed out (service is slow or unreachable).'
 if isinstance(e,httpx.HTTPStatusError):
  code = e.response.status_code
  body = ''
  try:
   err_json = e.response.json()
   body = err_json.get('error', {}).get('message') or err_json.get('message') or str(err_json)
  except Exception:
   body = e.response.text[:200]
  detail = f': {body}' if body else ''
  if code in (401, 403): return f'Authentication failed (HTTP {code}) - invalid API key or insufficient permissions{detail}'
  if code == 402: return f'Payment required or insufficient credits (HTTP 402){detail}'
  if code == 429: return f'Rate limit exceeded (HTTP 429){detail}'
  if code == 404: return f'Model or endpoint not found (HTTP 404){detail}'
  if code >= 500: return f'AI Provider service error (HTTP {code}){detail}'
  return f'Provider HTTP {code}{detail}'
 if isinstance(e,httpx.RequestError): return f'Network failure reaching AI provider: {str(e)[:150]}'
 return str(e)[:300]

async def gemini(prompt, model=None, system=None, audio=None, mime=None):
 key=secret('gemini.apiKey');
 if not key: raise RuntimeError('Gemini API key is not configured')
 model=model or setting()['providers']['gemini']['model']; parts=[]
 if system: parts.append({'text':system})
 if audio: parts.append({'inline_data':{'mime_type':mime or 'audio/webm','data':audio}})
 parts.append({'text':prompt})
 body={'contents':[{'parts':parts}]}
 async with httpx.AsyncClient(timeout=45) as c:
  r=await c.post(f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',params={'key':key},json=body); r.raise_for_status(); d=r.json()
 try:return d['candidates'][0]['content']['parts'][0]['text'],model
 except Exception: raise RuntimeError('Gemini returned no text')

async def openai_compatible(provider,prompt,model=None,system=None):
 s=setting()['providers'];
 if provider=='compatible': key=secret('gonka.apiKey') or os.getenv('OPENAI_COMPAT_API_KEY')
 elif provider=='gonka': key=secret('gonka.apiKey') or os.getenv('GONKA_API_KEY') or os.getenv('OPENAI_COMPAT_API_KEY')
 else: key=secret('huggingface.token') or os.getenv('HUGGINGFACE_TOKEN')
 if not key: raise RuntimeError(f'{provider} credential is not configured. Please set the API key in Settings or environment variables.')
 base=(s.get(provider, {}).get('baseUrl') if provider in ('gonka','compatible') else os.getenv('HUGGINGFACE_BASE_URL','https://router.huggingface.co/v1')).rstrip('/')
 if provider in ('gonka','compatible') and base.lower() in ('https://api.gonkarouter.io','http://api.gonkarouter.io'): base += '/v1'
 model=model or s.get(provider, {}).get('model') or (os.getenv('GONKA_MODEL') if provider=='gonka' else os.getenv('OPENAI_COMPAT_MODEL'))
 if not base or not model: raise RuntimeError(f'{provider} endpoint/model is not configured')
 messages=([{'role':'system','content':system}] if system else [])+[{'role':'user','content':prompt}]
 async with httpx.AsyncClient(timeout=45) as c:
  r=await c.post(base+'/chat/completions',headers={'Authorization':f'Bearer {key}'},json={'model':model,'messages':messages,'temperature':s.get('gemini', {}).get('temperature', 0.7),'max_tokens':s.get('gemini', {}).get('maxOutputTokens', 1024)}); r.raise_for_status(); d=r.json()
 try:return d['choices'][0]['message']['content'],model
 except Exception: raise RuntimeError(f'{provider} returned no text')

async def ask_provider(prompt):
 s=setting(); order=[s['providers']['primary']]
 if s['providers'].get('fallbackEnabled') and s['providers'].get('fallback') and s['providers']['fallback'] not in order: order.append(s['providers']['fallback'])
 errors=[]
 for p in order:
  try:
   started=time.time()
   if p=='gemini': text,model=await gemini(prompt)
   elif p in ('compatible','gonka','huggingface'): text,model=await openai_compatible(p,prompt)
   else: raise RuntimeError(f'Unsupported provider {p}')
   return {'text':text,'provider':p,'model':model,'latencyMs':round((time.time()-started)*1000),'usedFallback':p!=order[0]}
  except Exception as e: errors.append({'provider':p,'message':safe_error(e)}); log.warning('provider %s failed: %s',p,safe_error(e))
 raise HTTPException(503,detail={'message':'All configured AI providers failed','attempts':errors})

@app.get('/api/health')
async def health():
 c=db(); c.execute('select 1'); c.close(); return {'ok':True,'service':'victor-backend','version':app.version,'database':'sqlite','ffmpeg':{'ffmpeg':False,'note':'Calling media conversion is not configured'}}
@app.get('/api/auth/status')
def auth_status(request:Request,x_victor_pin:Optional[str]=Header(None)):
 return {'authRequired':bool(APP_PIN),'pinConfigured':bool(APP_PIN),'authorized':bool(APP_PIN and (x_victor_pin or request.cookies.get('victor_session',''))==APP_PIN)}
@app.post('/api/auth/login')
def login(body:AuthIn):
 if not APP_PIN: raise HTTPException(503,'APP_PIN is not configured')
 if not hmac.compare_digest(body.pin,APP_PIN): raise HTTPException(401,'Incorrect PIN')
 return {'ok':True}
@app.get('/api/diagnostics')
def diagnostics(_:bool=Depends(authorized)):
 s=public_settings(); checks=[{'name':'database','ok':True},{'name':'app_pin','ok':bool(APP_PIN)},{'name':'secret_encryption','ok':bool(os.getenv('SECRET_ENCRYPTION_KEY'))},{'name':'gemini','ok':bool(secret('gemini.apiKey'))},{'name':'gonka','ok':bool(secret('gonka.apiKey'))},{'name':'whatsapp','ok':bool(secret('whatsapp.accessToken') and s['whatsapp']['phoneNumberId'])},{'name':'calling_media','ok':False}]
 return {'checks':checks,'ready':{'aiText':any(x['ok'] for x in checks[3:5]),'browserVoice':True,'serverVoice':bool(secret('gemini.apiKey')),'whatsappMessaging':checks[5]['ok'],'whatsappCalling':False},'summary':'Live server checks completed; unsupported or unconfigured capabilities are reported honestly.'}
@app.get('/api/settings')
def get_settings(_:bool=Depends(authorized)): return public_settings()
@app.put('/api/settings')
def put_settings(patch:dict,_:bool=Depends(authorized)): return public_settings() if not save_setting(patch) else public_settings()
@app.post('/api/settings/reset')
def reset_settings(_:bool=Depends(authorized)): save_setting(DEFAULT_SETTINGS); return public_settings()
@app.put('/api/secrets/{key:path}')
def put_secret(key:str,body:SecretIn,_:bool=Depends(authorized)):
 if key not in {'gemini.apiKey','gonka.apiKey','huggingface.token','whatsapp.accessToken','whatsapp.appSecret'}: raise HTTPException(400,'Unsupported secret name')
 c=db(); c.execute('insert into secrets(name,ciphertext,updated_at) values(?,?,?) on conflict(name) do update set ciphertext=excluded.ciphertext,updated_at=excluded.updated_at',(key,encrypt(body.value),now())); c.commit(); c.close(); activity('secret_updated',{'name':key}); return {'ok':True,'status':credential_status(key)}
@app.delete('/api/secrets/{key:path}')
def delete_secret(key:str,_:bool=Depends(authorized)):
 c=db(); c.execute('delete from secrets where name=?',(key,)); c.commit(); c.close(); return {'ok':True}
@app.post('/api/chat')
async def chat(body:ChatIn,_:bool=Depends(authorized)):
 r=await ask_provider(body.message); c=db(); c.execute('insert into messages(direction,text,provider,model,status,created_at) values(?,?,?,?,?,?)',('outbound',body.message,r['provider'],r['model'],'processed',now())); c.commit(); c.close(); activity('ai_chat',{'provider':r['provider'],'model':r['model']}); return r
@app.post('/api/summarize')
async def summarize(body:SummaryIn,_:bool=Depends(authorized)):
 r=await ask_provider('Summarize this '+body.kind+' accurately. Do not invent facts:\n'+body.text); return {'ok':True,'summary':r['text'],'provider':r['provider'],'model':r['model']}
@app.post('/api/voice/transcribe')
async def transcribe(body:VoiceIn,_:bool=Depends(authorized)):
 try:text,model=await gemini('Transcribe the attached audio verbatim. Return only the transcript.',setting()['voice']['sttModel'],audio=body.audioBase64,mime=body.mimeType)
 except Exception as e: raise HTTPException(503,detail={'message':safe_error(e),'code':'transcription_failed'})
 return {'ok':True,'text':text,'provider':'gemini','model':model}
@app.post('/api/voice/speak')
async def speak(body:SpeakIn,_:bool=Depends(authorized)):
 key=secret('gemini.apiKey')
 if not key: raise HTTPException(503,detail={'message':'Gemini API key is not configured','code':'tts_not_configured'})
 model=setting()['voice']['ttsModel']; voice=body.voice or setting()['voice']['ttsVoice']; payload={'contents':[{'parts':[{'text':body.text}]}],'generationConfig':{'responseModalities':['AUDIO'],'speechConfig':{'voiceConfig':{'prebuiltVoiceConfig':{'voiceName':voice}}}}}
 async with httpx.AsyncClient(timeout=60) as c:
  r=await c.post(f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',params={'key':key},json=payload); r.raise_for_status(); d=r.json()
 try: audio=d['candidates'][0]['content']['parts'][0]['inlineData']['data']
 except Exception: raise HTTPException(502,'TTS provider returned no audio')
 return {'ok':True,'audioBase64':audio,'mimeType':'audio/wav','voice':voice,'model':model}
@app.post('/api/voice/ask')
async def voice_ask(body:dict,_:bool=Depends(authorized)): return await chat(ChatIn(message=body.get('text',''),sessionId=body.get('sessionId')),_)
@app.post('/api/voice/store')
def store_clip(body:VoiceIn,_:bool=Depends(authorized)): return save_recording(body.audioBase64,body.mimeType,'user_clip')

def save_recording(b64,mime,kind):
 try:data=base64.b64decode(b64,validate=True)
 except Exception: raise HTTPException(400,'Invalid base64 audio')
 if len(data)>MAX_BODY: raise HTTPException(413,'Audio is too large')
 ext='ogg' if 'ogg' in mime else ('mp4' if 'mp4' in mime else 'webm'); rid=pysecrets.token_hex(12); path=AUDIO/(rid+'.'+ext); path.write_bytes(data); s=setting(); exp=(datetime.now(timezone.utc)+timedelta(days=int(s['privacy']['retentionDays']))).isoformat(); c=db(); cur=c.execute('insert into recordings(kind,mime_type,path,bytes,expires_at,created_at) values(?,?,?,?,?,?)',(kind,mime,str(path),len(data),exp,now())); c.commit(); out=cur.lastrowid; c.close(); activity('recording_stored',{'id':out,'kind':kind}); return {'ok':True,'id':out}
@app.get('/api/recordings')
def recordings(kind:Optional[str]=None,q:Optional[str]=None,limit:int=60,_:bool=Depends(authorized)):
 sql='select * from recordings where 1=1'; args=[]
 if kind:sql+=' and kind=?';args.append(kind)
 if q:sql+=' and (transcript like ? or summary like ?)';args += [f'%{q}%',f'%{q}%']
 sql+=' order by id desc limit ?';args.append(min(limit,100)); c=db(); rows=[dict(x) for x in c.execute(sql,args)]; c.close();
 for r in rows: r['audioUrl']='/api/recordings/'+str(r['id'])+'/audio'
 return {'items':rows}
@app.get('/api/recordings/{rid}/audio')
def audio(rid:int,_:bool=Depends(authorized)):
 c=db(); r=c.execute('select * from recordings where id=?',(rid,)).fetchone(); c.close()
 if not r or not Path(r['path']).exists(): raise HTTPException(404,'Recording not found')
 return Response(Path(r['path']).read_bytes(),media_type=r['mime_type'])
@app.delete('/api/recordings/{rid}')
def del_recording(rid:int,_:bool=Depends(authorized)):
 c=db(); r=c.execute('select path from recordings where id=?',(rid,)).fetchone();
 if not r: c.close(); raise HTTPException(404,'Recording not found')
 Path(r['path']).unlink(missing_ok=True); c.execute('delete from recordings where id=?',(rid,)); c.commit(); c.close(); return {'ok':True}
@app.post('/api/recordings/purge-expired')
def purge(_:bool=Depends(authorized)):
 c=db(); rows=c.execute("select id,path from recordings where expires_at < ?",(now(),)).fetchall();
 for r in rows: Path(r['path']).unlink(missing_ok=True)
 c.execute("delete from recordings where expires_at < ?",(now(),)); c.commit(); c.close(); return {'ok':True,'removed':len(rows)}
@app.post('/api/recordings/{rid}/transcribe')
async def transcribe_recording(rid:int,_:bool=Depends(authorized)):
 c=db(); r=c.execute('select * from recordings where id=?',(rid,)).fetchone(); c.close()
 if not r: raise HTTPException(404,'Recording not found')
 out=await transcribe(VoiceIn(audioBase64=base64.b64encode(Path(r['path']).read_bytes()).decode(),mimeType=r['mime_type']),True); c=db(); c.execute('update recordings set transcript=? where id=?',(out['text'],rid)); c.commit(); c.close(); return out
@app.post('/api/recordings/{rid}/summarize')
async def summarize_recording(rid:int,_:bool=Depends(authorized)):
 c=db(); r=c.execute('select * from recordings where id=?',(rid,)).fetchone(); c.close()
 if not r or not r['transcript']: raise HTTPException(400,'Recording has no transcript')
 out=await summarize(SummaryIn(text=r['transcript'],kind='recording'),True); c=db(); c.execute('update recordings set summary=? where id=?',(out['summary'],rid)); c.commit(); c.close(); return out

def rows(path,limit=100):
 c=db(); r=[dict(x) for x in c.execute(path+' limit ?',(limit,))]; c.close(); return r
@app.get('/api/messages')
def messages(limit:int=60,_:bool=Depends(authorized)): return {'items':rows('select * from messages order by id desc',limit)}
@app.get('/api/contacts')
def contacts(limit:int=60,_:bool=Depends(authorized)): return {'items':rows('select * from contacts order by updated_at desc',limit)}
@app.get('/api/calls')
def calls(limit:int=60,_:bool=Depends(authorized)): return {'items':rows('select * from calls order by id desc',limit)}
@app.get('/api/calls/{cid}')
def call(cid:int,_:bool=Depends(authorized)):
 c=db();r=c.execute('select * from calls where id=?',(cid,)).fetchone();c.close();
 if not r:raise HTTPException(404,'Call not found')
 return dict(r)
@app.post('/api/calls/{cid}/end')
def end_call(cid:str,_:bool=Depends(authorized)): return {'ok':False,'status':'blocked','message':'No supported WhatsApp calling media stack is configured.'}
@app.get('/api/activity')
def activity_list(limit:int=60,_:bool=Depends(authorized)): return {'items':rows('select * from activity order by id desc',limit)}
@app.get('/api/reports/stats')
def stats(_:bool=Depends(authorized)):
 c=db();
 def count(q,args=()): return c.execute(q,args).fetchone()['n']
 day=datetime.now(timezone.utc).date().isoformat()
 all_time={'messagesIn':count("select count(*) n from messages where direction='inbound'"),'repliesSent':count("select count(*) n from messages where direction='outbound' and status in ('sent','processed')"),'callsHandled':count("select count(*) n from calls where status in ('connected','completed')"),'callsMissed':count("select count(*) n from calls where status in ('missed','rejected')"),'recordings':count('select count(*) n from recordings')}
 today={'messages':{'inbound':count("select count(*) n from messages where direction='inbound' and date(created_at)=?",(day,)),'repliesSent':count("select count(*) n from messages where direction='outbound' and status in ('sent','processed') and date(created_at)=?",(day,)),'repliesFailed':count("select count(*) n from messages where direction='outbound' and status='failed' and date(created_at)=?",(day,)),'voiceNotes':0,'flagged':0,'needsCallback':0},'calls':{'handled':count("select count(*) n from calls where status in ('connected','completed') and date(created_at)=?",(day,)),'missed':count("select count(*) n from calls where status in ('missed','rejected') and date(created_at)=?",(day,)),'totalSeconds':0}}
 recordings={'stored':all_time['recordings'],'transcribed':count("select count(*) n from recordings where transcript is not null and transcript!=''")}
 errors=count("select count(*) n from activity where kind like '%error%'")
 c.close(); return {'allTime':all_time,'todayCounts':today,'recordings':recordings,'errors':errors}
@app.get('/api/reports/list')
def report_list(_:bool=Depends(authorized)): return {'items':rows('select * from reports order by day desc',100)}
@app.get('/api/reports/day/{day}')
def report_day(day:str,_:bool=Depends(authorized)):
 c=db();r=c.execute('select report_json from reports where day=?',(day,)).fetchone();c.close(); return json.loads(r['report_json']) if r else {'day':day,'exists':False}
@app.post('/api/reports/day/{day}/generate')
def report_generate(day:str,_:bool=Depends(authorized)):
 c=db(); counts={k:c.execute(f"select count(*) n from {t} where date(created_at)=?",(day,)).fetchone()['n'] for k,t in [('messages','messages'),('recordings','recordings'),('activity','activity')]}; out={'day':day,'counts':counts,'generatedAt':now()}; c.execute('insert into reports(day,report_json,created_at) values(?,?,?) on conflict(day) do update set report_json=excluded.report_json,created_at=excluded.created_at',(day,json.dumps(out),now()));c.commit();c.close();return out
@app.post('/api/connection-tests')
def connection_tests(_:bool=Depends(authorized)): return diagnostics(True)
@app.post('/api/test/{target}')
async def test_target(target:str,_:bool=Depends(authorized)):
 if target in ('gemini','gemini_models','gemini_voices'):
  key=secret('gemini.apiKey')
  if not key: return {'ok':False,'error':{'message':'Gemini API key is not configured'}}
  try:
   async with httpx.AsyncClient(timeout=30) as c:
    r=await c.get('https://generativelanguage.googleapis.com/v1beta/models',params={'key':key}); r.raise_for_status(); data=r.json()
   models=[m for m in data.get('models',[]) if 'generateContent' in m.get('supportedGenerationMethods',[])]
   configured=setting()['providers']['gemini']['model']; ids=[m.get('name','').split('models/')[-1] for m in models]
   if target=='gemini_models': return {'ok':True,'provider':'gemini','count':len(ids),'models':ids,'detail':f'{len(ids)} generation models returned by Google.'}
   if configured not in ids: return {'ok':False,'provider':'gemini','model':configured,'statusCode':404,'error':{'message':f'Configured Gemini model {configured} is not available for this key. Use List models and select an available model.'}}
   text,model=await gemini('Reply with the single word OK.',configured); return {'ok':True,'provider':'gemini','model':model,'detail':text}
  except Exception as e:return {'ok':False,'error':{'message':safe_error(e)},'fix':'Press List models to confirm the model is available for this key.'}
 if target in ('compatible','gonka','gonka_models'):
  provider_name = 'gonka' if target in ('gonka','gonka_models') else 'compatible'
  started = time.time()
  try:
   text,model=await openai_compatible(provider_name,'Reply with the single word OK.')
   latency = round((time.time() - started) * 1000)
   return {'ok':True,'provider':provider_name,'model':model,'latencyMs':latency,'detail':text}
  except Exception as e:return {'ok':False,'error':{'message':safe_error(e)}}
 if target=='huggingface':
  try:text,model=await openai_compatible('huggingface','Reply with the single word OK.');return {'ok':True,'provider':'huggingface','model':model,'detail':text}
  except Exception as e:return {'ok':False,'error':{'message':safe_error(e)}}
 if target in ('whatsapp','whatsapp_calling'): return {'ok':False,'error':{'message':'WhatsApp is not configured or calling media is unsupported.'}}
 return {'ok':False,'error':{'message':'Unknown test target'}}
@app.get('/api/whatsapp/calling/eligibility')
def calling_eligibility(_:bool=Depends(authorized)): return {'eligible':False,'reason':'Calling media/signaling is not configured; Meta account and number eligibility must also be verified.'}
@app.post('/api/whatsapp/calling/enable')
def calling_enable(_:bool=Depends(authorized)): raise HTTPException(409,'Calling remains blocked until an eligible Meta number and supported media stack are configured.')
@app.get('/webhooks/whatsapp')
def webhook_verify(request:Request):
 q=request.query_params
 if q.get('hub.mode')=='subscribe' and hmac.compare_digest(q.get('hub.verify_token',''),os.getenv('WHATSAPP_VERIFY_TOKEN','not-configured')): return Response(q.get('hub.challenge',''),media_type='text/plain')
 raise HTTPException(403,'Webhook verification failed')
@app.post('/webhooks/whatsapp')
async def webhook(request:Request,x_hub_signature_256:Optional[str]=Header(None)):
 raw=await request.body(); app_secret=secret('whatsapp.appSecret')
 if not app_secret: raise HTTPException(503,'WhatsApp app secret is not configured')
 expected='sha256='+hmac.new(app_secret.encode(),raw,hashlib.sha256).hexdigest()
 if not x_hub_signature_256 or not hmac.compare_digest(expected,x_hub_signature_256): raise HTTPException(403,'Invalid webhook signature')
 data=json.loads(raw); processed=0; duplicates=0; sent=0
 for entry in data.get('entry',[]):
  for change in entry.get('changes',[]):
   value=change.get('value') or {}
   for status in value.get('statuses',[]):
    activity('whatsapp_status',{'id':status.get('id'),'status':status.get('status'),'recipient':status.get('recipient_id')})
   for msg in value.get('messages',[]):
    wamid=msg.get('id'); contact=(msg.get('from') or '')
    text=((msg.get('text') or {}).get('body') or '').strip()
    if not wamid or not text: continue
    c=db(); exists=c.execute('select 1 from messages where external_id=?',(wamid,)).fetchone()
    if exists: c.close(); duplicates+=1; continue
    c.execute('insert into messages(direction,external_id,contact,text,status,created_at) values(?,?,?,?,?,?)',('inbound',wamid,contact,text,'received',now())); c.commit(); c.close(); processed+=1
    if setting()['whatsapp'].get('autoReplyEnabled'):
     try:
      reply=await ask_provider(text)
      result=await whatsapp_send(contact,reply['text'])
      c=db(); c.execute('insert into messages(direction,contact,text,provider,model,status,created_at) values(?,?,?,?,?,?,?)',('outbound',contact,reply['text'],reply['provider'],reply['model'],'sent',now())); c.commit(); c.close(); sent+=1
      activity('whatsapp_auto_reply',{'contact':contact,'messageId':result.get('messages',[{}])[0].get('id'),'provider':reply['provider']})
     except Exception as e: activity('whatsapp_auto_reply_failed',{'contact':contact,'error':safe_error(e)})
 activity('whatsapp_webhook',{'object':data.get('object'),'entries':len(data.get('entry',[])),'processed':processed,'duplicates':duplicates,'sent':sent}); return {'ok':True,'processed':processed,'duplicates':duplicates,'sent':sent}

async def whatsapp_send(to:str,text:str):
 token=secret('whatsapp.accessToken'); phone=setting()['whatsapp'].get('phoneNumberId')
 if not token or not phone: raise RuntimeError('WhatsApp access token or phone number ID is not configured')
 version=setting()['whatsapp'].get('graphVersion') or 'v23.0'
 async with httpx.AsyncClient(timeout=30) as c:
  r=await c.post(f'https://graph.facebook.com/{version}/{phone}/messages',headers={'Authorization':f'Bearer {token}'},json={'messaging_product':'whatsapp','to':to,'type':'text','text':{'body':text[:4096]}})
  r.raise_for_status(); return r.json()
