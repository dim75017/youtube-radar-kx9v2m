'use strict';

/* Spotify Radar authentication
   -----------------------------
   Authorization Code with PKCE, entirely in the browser. The Spotify Client
   ID is public configuration; credentials and the PKCE transaction live only
   for the current browser tab/session. */
(function spotifyRadarAuthModule(global){
  const DEFAULT_CLIENT_ID='';
  const CLIENT_ID_KEY='spotify_radar_client_id';
  const VERIFIER_KEY='spotify_radar_pkce_verifier';
  const STATE_KEY='spotify_radar_oauth_state';
  const TRANSACTION_CLIENT_KEY='spotify_radar_oauth_client_id';
  const TRANSACTION_REDIRECT_KEY='spotify_radar_oauth_redirect_uri';
  const RETURN_URL_KEY='spotify_radar_oauth_return_url';
  const TOKENS_KEY='spotify_radar_oauth_tokens';
  const AUTHORIZE_ENDPOINT='https://accounts.spotify.com/authorize';
  const TOKEN_ENDPOINT='https://accounts.spotify.com/api/token';
  const SCOPES=Object.freeze([
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-modify-playback-state',
  ]);
  const TOKEN_EXPIRY_SKEW_MS=30000;
  let refreshInFlight=null;

  function storage(name){
    const value=global&&global[name];
    if(!value||typeof value.getItem!=='function'||typeof value.setItem!=='function'||typeof value.removeItem!=='function'){
      throw new Error('Le stockage sécurisé du navigateur est indisponible.');
    }
    return value;
  }

  function normalizedClientId(value){
    const id=String(value||'').trim();
    if(!/^[A-Za-z0-9]{16,32}$/.test(id)) throw new Error('Client ID Spotify invalide.');
    return id;
  }

  function clientId(){
    const value=storage('localStorage').getItem(CLIENT_ID_KEY);
    return normalizedClientId(value||DEFAULT_CLIENT_ID);
  }

  function clearTransaction(target=storage('sessionStorage')){
    [VERIFIER_KEY,STATE_KEY,TRANSACTION_CLIENT_KEY,TRANSACTION_REDIRECT_KEY,RETURN_URL_KEY].forEach(key=>target.removeItem(key));
  }

  function clearTokens(target=storage('sessionStorage')){
    target.removeItem(TOKENS_KEY);
    refreshInFlight=null;
  }

  function configure(value){
    const id=normalizedClientId(value);
    const local=storage('localStorage');
    const previous=local.getItem(CLIENT_ID_KEY)||DEFAULT_CLIENT_ID;
    if(previous!==id){
      clearTransaction();
      clearTokens();
    }
    local.setItem(CLIENT_ID_KEY,id);
    return id;
  }

  function redirectUri(){
    const base=global&&global.document&&global.document.baseURI||global&&global.location&&global.location.href;
    if(!base) throw new Error('Adresse de callback Spotify indisponible.');
    const url=new URL('callback.html',base);
    url.search='';
    url.hash='';
    return url.href;
  }

  function randomBase64Url(byteLength){
    if(!global.crypto||typeof global.crypto.getRandomValues!=='function') throw new Error('Générateur sécurisé indisponible.');
    const bytes=new Uint8Array(byteLength);
    global.crypto.getRandomValues(bytes);
    let binary='';
    for(const byte of bytes) binary+=String.fromCharCode(byte);
    return global.btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }

  async function sha256Base64Url(value){
    if(!global.crypto||!global.crypto.subtle||typeof global.crypto.subtle.digest!=='function') throw new Error('PKCE S256 indisponible.');
    const digest=await global.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
    let binary='';
    for(const byte of new Uint8Array(digest)) binary+=String.fromCharCode(byte);
    return global.btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }

  function currentRadarUrl(){
    const callback=new URL(redirectUri());
    const current=new URL(global&&global.location&&global.location.href||callback.href,callback);
    if(current.origin!==callback.origin||current.pathname===callback.pathname) return new URL('index.html',callback).href;
    return current.href;
  }

  function popupWaiter(popup,expectedOrigin){
    let settled=false;
    let timeoutId=null;
    let closedId=null;
    let onMessage=null;
    let rejectPromise=null;
    const cleanup=()=>{
      if(settled)return;
      settled=true;
      if(timeoutId!==null)global.clearTimeout(timeoutId);
      if(closedId!==null)global.clearInterval(closedId);
      if(onMessage&&typeof global.removeEventListener==='function')global.removeEventListener('message',onMessage);
    };
    const promise=new Promise((resolve,reject)=>{
      rejectPromise=reject;
      onMessage=event=>{
        if(!event||event.origin!==expectedOrigin||event.source!==popup||!event.data)return;
        if(event.data.type==='spotify-radar-auth-complete'){
          const connected=isConnected();
          clearTransaction();
          cleanup();
          if(connected)resolve(true);else reject(new Error('Session Spotify introuvable après la connexion.'));
        }else if(event.data.type==='spotify-radar-auth-error'){
          clearTransaction();
          cleanup();
          reject(new Error('La connexion Spotify n’a pas pu être validée.'));
        }
      };
      if(typeof global.addEventListener!=='function'){
        cleanup();
        reject(new Error('Écoute du callback Spotify indisponible.'));
        return;
      }
      global.addEventListener('message',onMessage);
      timeoutId=global.setTimeout(()=>{
        cleanup();
        try{if(popup&&!popup.closed)popup.close();}catch(error){}
        reject(new Error('La connexion Spotify a expiré.'));
      },300000);
      closedId=global.setInterval(()=>{
        let closed=false;
        try{closed=Boolean(popup.closed);}catch(error){closed=true;}
        if(closed){cleanup();reject(new Error('La fenêtre de connexion Spotify a été fermée.'));}
      },750);
    });
    return {promise,cancel(error){if(settled)return;cleanup();if(rejectPromise)rejectPromise(error||new Error('Connexion Spotify interrompue.'));}};
  }

  async function begin(options={}){
    const id=clientId();
    if(!id) throw new Error('Configurez le Client ID Spotify avant la connexion.');
    const callback=redirectUri();
    const usePopup=Boolean(options&&options.popup===true);
    let popup=null;
    if(usePopup&&typeof global.open==='function'){
      try{popup=global.open('about:blank','spotify-radar-auth','popup=yes,width=520,height=720,resizable=yes,scrollbars=yes');}catch(error){popup=null;}
    }
    const verifier=randomBase64Url(64);
    const state=randomBase64Url(32);
    let challenge='';
    try{challenge=await sha256Base64Url(verifier);}catch(error){try{if(popup&&!popup.closed)popup.close();}catch(closeError){}throw error;}
    const session=storage('sessionStorage');
    clearTransaction();
    clearTokens();
    session.setItem(VERIFIER_KEY,verifier);
    session.setItem(STATE_KEY,state);
    session.setItem(TRANSACTION_CLIENT_KEY,id);
    session.setItem(TRANSACTION_REDIRECT_KEY,callback);
    session.setItem(RETURN_URL_KEY,currentRadarUrl());
    if(popup){
      try{
        const popupSession=popup.sessionStorage;
        if(popupSession){
          clearTransaction(popupSession);
          clearTokens(popupSession);
          [VERIFIER_KEY,STATE_KEY,TRANSACTION_CLIENT_KEY,TRANSACTION_REDIRECT_KEY,RETURN_URL_KEY]
            .forEach(key=>popupSession.setItem(key,session.getItem(key)));
        }
      }catch(error){}
    }
    const url=new URL(AUTHORIZE_ENDPOINT);
    url.search=new URLSearchParams({
      client_id:id,
      response_type:'code',
      redirect_uri:callback,
      scope:SCOPES.join(' '),
      state,
      code_challenge_method:'S256',
      code_challenge:challenge,
    }).toString();
    if(popup){
      let usable=true;
      try{usable=!popup.closed;}catch(error){usable=false;}
      if(usable){
        const waiter=popupWaiter(popup,new URL(callback).origin);
        try{
          if(popup.location&&typeof popup.location.replace==='function')popup.location.replace(url.href);
          else popup.location=url.href;
          return await waiter.promise.catch(error=>{clearTransaction();throw error;});
        }catch(error){
          waiter.promise.catch(()=>{});
          waiter.cancel(error);
          try{if(!popup.closed)popup.close();}catch(closeError){}
          if(error&&/fenêtre|expiré|validée|Session Spotify|interrompue/.test(String(error.message||''))) throw error;
        }
      }
    }
    if(!global.location||typeof global.location.assign!=='function') throw new Error('Navigation Spotify indisponible.');
    global.location.assign(url.href);
    return url.href;
  }

  function readTokens(target=storage('sessionStorage')){
    const raw=target.getItem(TOKENS_KEY);
    if(!raw) return null;
    try{
      const value=JSON.parse(raw);
      if(!value||typeof value!=='object'||typeof value.access_token!=='string'||!value.access_token) return null;
      return value;
    }catch(error){
      return null;
    }
  }

  function saveTokens(payload,previousRefreshToken='',target=storage('sessionStorage')){
    if(!payload||typeof payload!=='object'||payload.token_type!=='Bearer'||typeof payload.access_token!=='string'||!payload.access_token){
      throw new Error('Réponse d’authentification Spotify invalide.');
    }
    const expiresIn=Number(payload.expires_in);
    if(!Number.isFinite(expiresIn)||expiresIn<=0) throw new Error('Expiration Spotify invalide.');
    const refreshToken=typeof payload.refresh_token==='string'&&payload.refresh_token?payload.refresh_token:previousRefreshToken;
    const record={
      access_token:payload.access_token,
      refresh_token:refreshToken,
      token_type:'Bearer',
      scope:typeof payload.scope==='string'?payload.scope:'',
      expires_at:Date.now()+Math.floor(expiresIn*1000),
    };
    target.setItem(TOKENS_KEY,JSON.stringify(record));
    return record;
  }

  async function tokenRequest(parameters){
    if(typeof global.fetch!=='function') throw new Error('Connexion Spotify indisponible.');
    const response=await global.fetch(TOKEN_ENDPOINT,{
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams(parameters).toString(),
      cache:'no-store',
      credentials:'omit',
    });
    if(!response||!response.ok) throw new Error('Spotify a refusé l’authentification.');
    return response.json();
  }

  function callbackUrl(input){
    const expected=new URL(redirectUri());
    const current=new URL(input||global&&global.location&&global.location.href||'',expected);
    if(current.origin!==expected.origin||current.pathname!==expected.pathname||current.hash){
      throw new Error('Adresse de callback Spotify invalide.');
    }
    return current;
  }

  function callbackSession(){
    const own=storage('sessionStorage');
    try{
      const opener=global&&global.opener;
      if(!opener||opener.closed||!opener.location||!global.location)return own;
      const openerOrigin=new URL(opener.location.href).origin;
      const currentOrigin=new URL(global.location.href).origin;
      if(openerOrigin===currentOrigin&&opener.sessionStorage)return opener.sessionStorage;
    }catch(error){}
    return own;
  }

  async function finishCallback(input){
    const current=callbackUrl(input);
    const parameters=current.searchParams;
    const session=callbackSession();
    const expectedState=session.getItem(STATE_KEY)||'';
    const verifier=session.getItem(VERIFIER_KEY)||'';
    const transactionClient=session.getItem(TRANSACTION_CLIENT_KEY)||'';
    const transactionRedirect=session.getItem(TRANSACTION_REDIRECT_KEY)||'';
    const errors=parameters.getAll('error');
    const codes=parameters.getAll('code');
    const states=parameters.getAll('state');
    try{
      if(errors.length) throw new Error('Connexion Spotify annulée ou refusée.');
      if(codes.length!==1||states.length!==1||!codes[0]||!states[0]) throw new Error('Callback Spotify incomplet.');
      if(!expectedState||states[0]!==expectedState) throw new Error('État OAuth Spotify invalide.');
      if(!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) throw new Error('Vérificateur PKCE invalide.');
      const id=clientId();
      const callback=redirectUri();
      if(!transactionClient||transactionClient!==id||!transactionRedirect||transactionRedirect!==callback){
        throw new Error('Transaction Spotify incohérente.');
      }
      const payload=await tokenRequest({
        grant_type:'authorization_code',
        code:codes[0],
        redirect_uri:callback,
        client_id:id,
        code_verifier:verifier,
      });
      saveTokens(payload,'',session);
      return true;
    }finally{
      clearTransaction(session);
    }
  }

  async function refreshAccessToken(tokens){
    if(!tokens||typeof tokens.refresh_token!=='string'||!tokens.refresh_token) return '';
    const payload=await tokenRequest({
      grant_type:'refresh_token',
      refresh_token:tokens.refresh_token,
      client_id:clientId(),
    });
    return saveTokens(payload,tokens.refresh_token).access_token;
  }

  async function accessToken(options={}){
    const tokens=readTokens();
    if(!tokens) return '';
    const forceRefresh=Boolean(options&&options.forceRefresh===true);
    if(!forceRefresh&&Number(tokens.expires_at)>Date.now()+TOKEN_EXPIRY_SKEW_MS) return tokens.access_token;
    if(!tokens.refresh_token){
      clearTokens();
      return '';
    }
    if(!refreshInFlight){
      refreshInFlight=refreshAccessToken(tokens).catch(error=>{clearTokens();throw error;}).finally(()=>{refreshInFlight=null;});
    }
    return refreshInFlight;
  }

  function disconnect(){
    clearTransaction();
    clearTokens();
  }

  function isConnected(){
    const tokens=readTokens();
    return Boolean(tokens&&(Number(tokens.expires_at)>Date.now()||tokens.refresh_token));
  }

  const api=Object.freeze({configure,clientId,redirectUri,begin,finishCallback,accessToken,disconnect,isConnected});
  global.SpotifyRadarAuth=api;
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
