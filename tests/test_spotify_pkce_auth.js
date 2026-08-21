'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto').webcrypto;
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {TextEncoder}=require('node:util');

class MemoryStorage{
  constructor(){this.values=new Map();}
  getItem(key){return this.values.has(key)?this.values.get(key):null;}
  setItem(key,value){this.values.set(String(key),String(value));}
  removeItem(key){this.values.delete(String(key));}
  key(index){return [...this.values.keys()][index]||null;}
  get length(){return this.values.size;}
}

function base64Url(bytes){
  return Buffer.from(bytes).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

(async()=>{
  const root=path.join(__dirname,'..');
  const source=fs.readFileSync(path.join(root,'spotify','auth.js'),'utf8');
  const callback=fs.readFileSync(path.join(root,'spotify','callback.html'),'utf8');
  const localStorage=new MemoryStorage();
  const sessionStorage=new MemoryStorage();
  const location={
    href:'https://radar.example/releases/spotify/index.html?tab=tracks#detail',
    assigned:'',
    assign(value){this.assigned=String(value);},
  };
  const messageListeners=new Set();
  const requests=[];
  const tokenResponses=[
    {access_token:'access-one',refresh_token:'refresh-one',token_type:'Bearer',expires_in:3600,scope:'streaming'},
    {access_token:'access-two',token_type:'Bearer',expires_in:3600,scope:'streaming'},
    {access_token:'access-three',token_type:'Bearer',expires_in:3600,scope:'streaming'},
  ];
  const context={
    URL,URLSearchParams,Uint8Array,TextEncoder,JSON,Date,Promise,Object,String,Number,Boolean,Math,RegExp,Error,
    crypto,
    btoa:value=>Buffer.from(value,'binary').toString('base64'),
    localStorage,sessionStorage,location,
    setTimeout,clearTimeout,setInterval,clearInterval,
    addEventListener(type,listener){if(type==='message')messageListeners.add(listener);},
    removeEventListener(type,listener){if(type==='message')messageListeners.delete(listener);},
    fetch:async(url,options)=>{
      requests.push({url:String(url),options});
      return {ok:true,json:async()=>tokenResponses.shift()};
    },
  };
  context.globalThis=context;
  vm.runInNewContext(source,context,{filename:'spotify/auth.js'});
  const auth=context.SpotifyRadarAuth;

  assert.ok(auth,'the browser module exposes SpotifyRadarAuth');
  assert.deepEqual(Object.keys(auth),['configure','clientId','redirectUri','begin','finishCallback','accessToken','disconnect','isConnected']);
  assert.throws(()=>auth.configure('short'),/Client ID Spotify invalide/);
  const clientId='31yyjjxidxlrdjiq3t2jb4pbrqei';
  assert.equal(auth.clientId(),clientId,'the authorized public Client ID is available by default');
  assert.equal(localStorage.getItem('spotify_radar_client_id'),null,'the default public Client ID needs no browser setup');
  assert.equal(auth.configure(` ${clientId} `),clientId);
  assert.equal(auth.clientId(),clientId);
  assert.equal(localStorage.getItem('spotify_radar_client_id'),clientId,'only the public Client ID is persistent');
  assert.equal(auth.redirectUri(),'https://radar.example/releases/spotify/callback.html','the callback URI is exact and strips the current query/hash');

  const authorizationUrl=await auth.begin();
  assert.equal(location.assigned,authorizationUrl,'begin navigates to the exact generated authorization URL');
  const authorization=new URL(authorizationUrl);
  assert.equal(authorization.origin,'https://accounts.spotify.com');
  assert.equal(authorization.pathname,'/authorize');
  assert.equal(authorization.searchParams.get('client_id'),clientId);
  assert.equal(authorization.searchParams.get('response_type'),'code');
  assert.equal(authorization.searchParams.get('redirect_uri'),auth.redirectUri());
  assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');
  assert.deepEqual(
    new Set(authorization.searchParams.get('scope').split(' ')),
    new Set(['streaming','user-read-email','user-read-private','user-modify-playback-state']),
  );
  const verifier=sessionStorage.getItem('spotify_radar_pkce_verifier');
  const state=sessionStorage.getItem('spotify_radar_oauth_state');
  assert.match(verifier,/^[A-Za-z0-9_-]{43,128}$/,'PKCE verifier uses an allowed high-entropy representation');
  assert.match(state,/^[A-Za-z0-9_-]+$/,'OAuth state is generated with secure URL-safe bytes');
  assert.equal(authorization.searchParams.get('state'),state);
  const expectedChallenge=base64Url(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
  assert.equal(authorization.searchParams.get('code_challenge'),expectedChallenge,'the challenge is the S256 digest of the stored verifier');
  assert.equal(requests.length,0,'starting authorization performs no token request');

  location.href=`${auth.redirectUri()}?code=authorization-code&state=${encodeURIComponent(state)}`;
  assert.equal(await auth.finishCallback(),true);
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'https://accounts.spotify.com/api/token');
  assert.equal(requests[0].options.method,'POST');
  assert.equal(requests[0].options.credentials,'omit');
  const exchangeBody=new URLSearchParams(requests[0].options.body);
  assert.equal(exchangeBody.get('grant_type'),'authorization_code');
  assert.equal(exchangeBody.get('client_id'),clientId);
  assert.equal(exchangeBody.get('redirect_uri'),auth.redirectUri());
  assert.equal(exchangeBody.get('code_verifier'),verifier);
  assert.equal(sessionStorage.getItem('spotify_radar_pkce_verifier'),null,'the verifier is single-use');
  assert.equal(sessionStorage.getItem('spotify_radar_oauth_state'),null,'the state is single-use');
  assert.equal(await auth.accessToken(),'access-one');
  assert.equal(auth.isConnected(),true);

  const storedTokens=JSON.parse(sessionStorage.getItem('spotify_radar_oauth_tokens'));
  storedTokens.expires_at=0;
  sessionStorage.setItem('spotify_radar_oauth_tokens',JSON.stringify(storedTokens));
  assert.equal(await auth.accessToken(),'access-two','an expired access token is refreshed in-session');
  const refreshBody=new URLSearchParams(requests[1].options.body);
  assert.equal(refreshBody.get('grant_type'),'refresh_token');
  assert.equal(refreshBody.get('refresh_token'),'refresh-one');
  assert.equal(refreshBody.get('client_id'),clientId);
  assert.equal(JSON.parse(sessionStorage.getItem('spotify_radar_oauth_tokens')).refresh_token,'refresh-one','Spotify may omit an unchanged refresh token');
  assert.equal(await auth.accessToken(),'access-two','a fresh token is reused in the normal flow');
  assert.equal(requests.length,2,'the normal flow does not refresh a valid token');
  assert.equal(await auth.accessToken({forceRefresh:true}),'access-three','a caller can recover from a Web API 401 with a forced refresh');
  const forcedRefreshBody=new URLSearchParams(requests[2].options.body);
  assert.equal(forcedRefreshBody.get('grant_type'),'refresh_token');
  assert.equal(forcedRefreshBody.get('refresh_token'),'refresh-one');

  assert.deepEqual([...localStorage.values.keys()],['spotify_radar_client_id'],'access and refresh credentials never enter persistent storage');
  assert.doesNotMatch(source,/client_secret|console\.(?:log|info|warn|error)|localStorage\.setItem\([^)]*(?:access|refresh|token|verifier|state)/i);
  auth.disconnect();
  assert.equal(auth.isConnected(),false);
  assert.equal(sessionStorage.length,0,'disconnect clears every session credential and transaction value');
  assert.equal(auth.clientId(),clientId,'disconnect keeps the public Client ID configuration');

  location.href='https://radar.example/releases/spotify/index.html?tab=tracks#track-42';
  let popupAuthorizationUrl='';
  const popup={
    closed:false,
    location:{replace(value){
      popupAuthorizationUrl=String(value);
      queueMicrotask(()=>{
        sessionStorage.setItem('spotify_radar_oauth_tokens',JSON.stringify({access_token:'popup-access',refresh_token:'popup-refresh',token_type:'Bearer',scope:'streaming',expires_at:Date.now()+3600000}));
        for(const listener of [...messageListeners])listener({origin:'https://radar.example',source:popup,data:{type:'spotify-radar-auth-complete'}});
      });
    }},
    close(){this.closed=true;},
  };
  context.open=(url,name,features)=>{
    assert.equal(url,'about:blank');
    assert.equal(name,'spotify-radar-auth');
    assert.match(features,/popup=yes/);
    return popup;
  };
  assert.equal(await auth.begin({popup:true}),true,'popup authorization resolves only after the completion message');
  assert.equal(new URL(popupAuthorizationUrl).origin,'https://accounts.spotify.com');
  assert.equal(location.assigned,authorizationUrl,'popup authorization leaves the Radar page in place');
  assert.equal(sessionStorage.getItem('spotify_radar_oauth_return_url'),null,'the completed popup transaction is cleared');
  assert.equal(await auth.accessToken(),'popup-access');
  auth.disconnect();

  assert.match(callback,/<script src="\.\/auth\.js\?v=20260821-web-playback-v2"><\/script>/);
  assert.match(callback,/SpotifyRadarAuth\.finishCallback\(\)/);
  assert.match(callback,/postMessage\(\{type:'spotify-radar-auth-complete'\},origin\)/);
  assert.match(callback,/window\.location\.replace\(returnUrl\)/);
  assert.match(callback,/window\.close\(\)/);
  assert.doesNotMatch(callback,/client_secret|access_token|refresh_token/i);
  console.log('Spotify Authorization Code PKCE auth: OK');
})().catch(error=>{
  console.error(error);
  process.exitCode=1;
});
