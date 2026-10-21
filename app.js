// R Music — ไฟล์ JS เดียว: โหมดเว็บเพลเยอร์ (/) และโหมดจอ TV (/tv)
(() => {
    const IS_TV = /^\/tv\/?$/.test(location.pathname);
    if (IS_TV) {
        // ล้างหน้าเว็บเพลเยอร์ออก แล้วใส่โครงหน้า TV จาก <template id="tv-tpl"> (กัน id ซ้ำกัน)
        document.title = 'R Music TV';
        document.documentElement.classList.add('tv-mode');
        const tpl = document.getElementById('tv-tpl');
        [...document.body.children].forEach(el => { if (el.tagName !== 'SCRIPT' && el !== tpl) el.remove(); });
        document.body.appendChild(tpl.content.cloneNode(true));
        runTv();
    } else {
        runMain();
    }

    // ================= โหมดเว็บเพลเยอร์ (เดิมคือ main.js) =================
    async function runMain() {
        //============================================================
        // CONFIG — Spotify Client ID
        // ============================================================
        const CLIENT_ID = '0c0581fc99704656885f8fbc84d0fcf6'; // Spotify Client ID — แก้ค่านี้ตรงนี้
        const REDIRECT_URI = window.location.origin;

        // ---------- สัญลักษณ์ E (Explicit = เนื้อหาไม่เหมาะสม) ----------
        const EXPLICIT_HTML = '<span class="rank-explicit" title="เนื้อหาไม่เหมาะสม (Explicit)">E</span>';
        const explicitMap = new Map(); // trackId -> true/false จำผลไว้ ไม่ต้องถามซ้ำ
        const explicitRequests = new Map();
        const rememberExplicit = t => { if (t?.id && typeof t.explicit === 'boolean') explicitMap.set(t.id, t.explicit); return t?.explicit ? EXPLICIT_HTML : ''; };
        // เพลงจาก Web Playback SDK ไม่มีข้อมูล explicit จึงถาม Spotify แล้วอัปเดตป้ายที่ Player และหน้าเนื้อเพลง
        function setArtistWithBadge(el, text, explicit) {
            if (!el) return;
            el.textContent = '';
            if (explicit) { const b = document.createElement('span'); b.className = 'rank-explicit'; b.title = 'เนื้อหาไม่เหมาะสม (Explicit)'; b.textContent = 'E'; el.appendChild(b); }
            el.appendChild(document.createTextNode(text));
        }
        async function updateExplicitBadges(track) {
            if (!track?.id) return;
            const text = (track.artists || []).map(a => a.name).join(', ');
            const apply = ex => { setArtistWithBadge(document.getElementById('player-artist'), text, ex); setArtistWithBadge(document.getElementById('lyrics-modal-artist'), text, ex); };
            if (explicitMap.has(track.id)) { apply(explicitMap.get(track.id)); return; }
            apply(false);
            if (explicitRequests.has(track.id)) return explicitRequests.get(track.id);
            const request = fetchWebApi(`v1/tracks/${track.id}`)
                .then(full => {
                    explicitMap.set(track.id, !!full?.explicit);
                    if (full?.explicit && window._currentExplicitTrackId === track.id) apply(true);
                })
                .catch(error => {
                    if (error?.status !== 429) console.warn('Could not load explicit track metadata:', error);
                })
                .finally(() => explicitRequests.delete(track.id));
            explicitRequests.set(track.id, request);
            return request;
        }
        let isPremium = true; // false เมื่อรู้ว่าเป็นบัญชี Free (เล่นเพลงบนเว็บไม่ได้ แต่ยังค้นหา/เรียกดูได้)
        let developerSoundsCache = [];

        // ============================================================
        // SPOTIFY AUTH (PKCE)
        // ============================================================
        function generateRandomString(length) {
            let text = '';
            const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            for (let i = 0; i < length; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
            return text;
        }
        async function generateCodeChallenge(verifier) {
            const data = new TextEncoder().encode(verifier);
            const digest = await window.crypto.subtle.digest('SHA-256', data);
            return btoa(String.fromCharCode.apply(null, [...new Uint8Array(digest)])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }
        // ============================================================
        // รองรับการเปิดเว็บนี้ในเว็บวิวที่ฝังอยู่ในแอป (เช่น เปิดผ่านแอปมือถือของคุณเอง)
        // ============================================================
        // เว็บวิวของแอป Android มาตรฐานจะมี ";wv)" ต่อท้ายชื่อ Android ใน User-Agent เสมอ ส่วน iOS ถ้าไม่ใช่ Safari จริง
        // (ไม่มีคำว่า "Safari" ต่อท้าย) มักเป็นเว็บวิวที่แอปอื่นฝังมา (WKWebView) — ใช้เช็คคร่าวๆ ว่าไม่ได้เปิดในเบราว์เซอร์ปกติ
        function isEmbeddedWebView() {
            const ua = navigator.userAgent || '';
            if (/; wv\)/i.test(ua)) return true;
            const isIOS = /iPhone|iPad|iPod/.test(ua);
            if (isIOS && !/Safari/i.test(ua)) return true;
            return false;
        }
        // เว็บวิวหลายตัว (โดยเฉพาะ WKWebView ของ iOS) ไม่มี EME (Encrypted Media Extensions) เลย ทำให้ Spotify Web
        // Playback SDK ซึ่งต้องใช้ DRM (Widevine) เล่นเสียงเองในหน้านี้ไม่ได้ ต่อให้ล็อกอินผ่านและเป็น Premium ก็ตาม
        // เช็คด้วยการขอสิทธิ์ Widevine จริงๆ ก่อน แทนที่จะเดาจาก User-Agent อย่างเดียว
        async function canUseLocalPlayback() {
            if (typeof navigator.requestMediaKeySystemAccess !== 'function') return false;
            try {
                await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
                    initDataTypes: ['cenc'],
                    audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }],
                }]);
                return true;
            } catch (e) { return false; }
        }
        // เมื่อเล่นเสียงในหน้านี้เองไม่ได้ (เช่น อยู่ในเว็บวิวของแอป) ให้สลับไปใช้ Spotify Connect แทน: เปิดตัวเลือก
        // อุปกรณ์เดิมที่มีอยู่แล้ว (ใช้ร่วมกับฟีเจอร์แชร์ไป TV) ให้ผู้ใช้เลือก "เล่นผ่านแอป Spotify บนมือถือ" หรืออุปกรณ์อื่น
        // แทนได้เลย ปุ่มเล่น/หยุด/ข้าม/เนื้อเพลงทั้งหมดยังใช้งานได้ปกติผ่านกลไก remote ที่มีอยู่แล้วในเว็บนี้
        function useRemotePlaybackFallback() {
            showToast('ℹ️ เบราว์เซอร์นี้เล่นเสียงเองไม่ได้ เลือกอุปกรณ์ (เช่น แอป Spotify บนมือถือ) เพื่อควบคุมจากที่นี่แทน', 'info');
            overlayOpen('tv'); tvRender(); loadDevices();
        }

        async function loginWithSpotify(forceDialog = false) {
            if (!CLIENT_ID || CLIENT_ID === 'YOUR_CLIENT_ID_HERE') { alert('กรุณาใส่ Spotify Client ID ที่ตัวแปร CLIENT_ID ใน main.js'); return; }
            const verifier = generateRandomString(128);
            const challenge = await generateCodeChallenge(verifier);
            localStorage.setItem('spotify_verifier', verifier);
            const params = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI, code_challenge_method: 'S256', code_challenge: challenge, scope: ['user-read-private', 'user-read-email', 'streaming', 'user-read-playback-state', 'user-modify-playback-state', 'user-library-read', 'user-library-modify', 'user-follow-read', 'user-follow-modify', 'playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-private', 'playlist-modify-public', 'user-top-read', 'user-read-recently-played'].join(' ') });
            // show_dialog=true บังคับให้ Spotify แสดงหน้าขออนุญาตใหม่ (ใช้ตอนสลับบัญชี / ขอสิทธิ์เพิ่ม)
            if (forceDialog) params.set('show_dialog', 'true');
            const authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;
            // Spotify ปฏิเสธไม่ให้ล็อกอินถ้าเปิดหน้านี้อยู่ในเว็บวิวที่ฝังอยู่ในแอป (ขึ้น "Opening in an embedded
            // browser is not supported") — ลอง window.open ก่อน เผื่อแอปตั้งค่าให้ลิงก์แบบนี้เด้งออกไปเบราว์เซอร์นอกแอปได้
            // (เช่น Chrome Custom Tabs / SFSafariViewController) ถ้าเปิดไม่ได้ (โดนบล็อกป็อปอัพ) ค่อย fallback ไปแบบเดิม
            if (isEmbeddedWebView()) {
                const w = window.open(authUrl, '_blank');
                if (!w) window.location.href = authUrl;
                return;
            }
            window.location.href = authUrl;
        }
        async function handleRedirect() {
            const params = new URLSearchParams(window.location.search);
            const code = params.get('code');
            if (code) {
                window.history.replaceState({}, document.title, '/');
                const verifier = localStorage.getItem('spotify_verifier');
                const body = new URLSearchParams({ client_id: CLIENT_ID, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
                try {
                    const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
                    if (!response.ok) throw new Error('HTTP status ' + response.status);
                    const data = await response.json();
                    localStorage.setItem('spotify_access_token', data.access_token);
                    localStorage.setItem('spotify_refresh_token', data.refresh_token);
                    console.log('Granted scopes:', data.scope);
                    return data.access_token;
                } catch (error) { console.error('Error fetching token:', error); return null; }
            }
            return localStorage.getItem('spotify_access_token');
        }

        function clearSession() {
            ['spotify_access_token', 'spotify_refresh_token', 'spotify_verifier'].forEach(k => localStorage.removeItem(k));
        }
        function disconnectPlayer() {
            try { window._spotifyPlayer?.pause(); window._spotifyPlayer?.disconnect(); } catch (e) { }
        }
        // ออกจากระบบ: ล้าง token แล้วกลับไปหน้า Login
        function logout() {
            disconnectPlayer();
            clearSession();
            window.location.replace('/');
        }
        // สลับบัญชี: ล้าง token แล้วส่งไปหน้า Spotify ใหม่ (มีลิงก์ "ไม่ใช่คุณ?" ให้เปลี่ยนบัญชี)
        function switchAccount() {
            disconnectPlayer();
            clearSession();
            loginWithSpotify(true);
        }

        // ============================================================
        // SPOTIFY API
        // ============================================================
        // A Spotify 429 triggers a persisted app-wide cooldown so no endpoint keeps retrying
        // while Spotify is rate-limiting this client.
        let rateLimitUntil = 0;
        let lastSpotifyRequestAt = 0;
        const MIN_SPOTIFY_REQUEST_INTERVAL_MS = 300;
        const SPOTIFY_429_COOLDOWN_MS = 25 * 60 * 1000;
        const SPOTIFY_429_STORAGE_KEY = 'spotify_429_maintenance_until';
        const spotifyGetRequests = new Map();
        const spotifyDelay = ms => new Promise(resolve => setTimeout(resolve, ms));
        let spotify429MaintenanceUntil = 0;
        let spotify429CountdownTimer = null;
        function renderSpotify429Maintenance() {
            const overlay = document.getElementById('spotify-429-overlay');
            const countdown = document.getElementById('spotify-429-countdown');
            const returnTime = document.getElementById('spotify-429-return-time');
            if (!overlay || !countdown || !returnTime) return;
            overlay.classList.remove('hidden');
            document.body.style.overflow = 'hidden';
            const remainingMs = Math.max(0, spotify429MaintenanceUntil - Date.now());
            if (!remainingMs) {
                clearInterval(spotify429CountdownTimer);
                spotify429CountdownTimer = null;
                try { localStorage.removeItem(SPOTIFY_429_STORAGE_KEY); } catch (error) { console.warn('Could not clear Spotify cooldown:', error); }
                window.location.reload();
                return;
            }
            const remainingSeconds = Math.ceil(remainingMs / 1000);
            const minutes = Math.floor(remainingSeconds / 60);
            const seconds = remainingSeconds % 60;
            const countdownText = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
            countdown.textContent = countdownText;
            const returnAt = new Date(spotify429MaintenanceUntil);
            const returnClock = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false }).format(returnAt);
            returnTime.textContent = `เราจะกลับมาอีกในเวลา ${returnClock} น. (${countdownText})`;
        }
        function startSpotify429Maintenance(until = Date.now() + SPOTIFY_429_COOLDOWN_MS, persist = true) {
            if (spotify429MaintenanceUntil > Date.now()) return;
            spotify429MaintenanceUntil = until;
            rateLimitUntil = Math.max(rateLimitUntil, until);
            if (persist) {
                try { localStorage.setItem(SPOTIFY_429_STORAGE_KEY, String(until)); }
                catch (error) { console.warn('Could not persist Spotify cooldown:', error); }
            }
            try { stopRankingView(); } catch (error) { console.warn('Could not stop ranking refresh:', error); }
            try { disconnectPlayer(); } catch (error) { console.warn('Could not disconnect Spotify player:', error); }
            renderSpotify429Maintenance();
            clearInterval(spotify429CountdownTimer);
            spotify429CountdownTimer = setInterval(renderSpotify429Maintenance, 1000);
        }
        function isSpotify429MaintenanceActive() {
            return spotify429MaintenanceUntil > Date.now();
        }
        function restoreSpotify429Maintenance() {
            try {
                const storedCooldown = Number(localStorage.getItem(SPOTIFY_429_STORAGE_KEY));
                if (Number.isFinite(storedCooldown) && storedCooldown > Date.now()) {
                    startSpotify429Maintenance(storedCooldown, false);
                } else if (storedCooldown) {
                    localStorage.removeItem(SPOTIFY_429_STORAGE_KEY);
                }
            } catch (error) {
                console.warn('Could not read Spotify cooldown:', error);
            }
        }
        window.addEventListener('storage', event => {
            if (event.key !== SPOTIFY_429_STORAGE_KEY) return;
            const until = Number(event.newValue);
            if (Number.isFinite(until) && until > Date.now()) startSpotify429Maintenance(until, false);
        });
        function spotifyRequestMessage(error, action) {
            if (error?.status === 429) {
                const seconds = Math.max(1, Math.ceil((rateLimitUntil - Date.now()) / 1000));
                return `Spotify จำกัดคำขอชั่วคราว จึง${action}ไม่ได้ในตอนนี้ ลองใหม่ในประมาณ ${seconds} วินาที`;
            }
            if (error?.status === 403) return `Spotify ไม่อนุญาตให้${action}ด้วยสิทธิ์ของบัญชีนี้`;
            if (error?.status === 404) return `ไม่พบข้อมูลที่ต้องการ${action}`;
            if (error?.status === 401) return 'เซสชัน Spotify หมดอายุ กรุณาเข้าสู่ระบบใหม่';
            return `เชื่อมต่อ Spotify เพื่อ${action}ไม่สำเร็จ กรุณาลองใหม่`;
        }
        let apiQueue = Promise.resolve();
        async function fetchWebApi(endpoint, method = 'GET', body) {
            if (isSpotify429MaintenanceActive()) {
                const error = new Error('Spotify maintenance cooldown is active');
                error.status = 429;
                return Promise.reject(error);
            }
            const isGet = method === 'GET';
            if (isGet && spotifyGetRequests.has(endpoint)) return spotifyGetRequests.get(endpoint);
            const request = new Promise((resolve, reject) => {
                apiQueue = apiQueue.then(async () => {
                    try {
                        let result;
                        for (let attempt = 0; ; attempt++) {
                            if (isSpotify429MaintenanceActive()) {
                                const error = new Error('Spotify maintenance cooldown is active');
                                error.status = 429;
                                throw error;
                            }
                            const wait = Math.max(
                                rateLimitUntil - Date.now(),
                                MIN_SPOTIFY_REQUEST_INTERVAL_MS - (Date.now() - lastSpotifyRequestAt)
                            );
                            if (wait > 0) await spotifyDelay(wait);
                            lastSpotifyRequestAt = Date.now();
                            try {
                                const token = localStorage.getItem('spotify_access_token');
                                const res = await fetch(`https://api.spotify.com/${endpoint}`, { headers: { Authorization: `Bearer ${token}` }, method, body: body ? JSON.stringify(body) : undefined });
                                if (res.status === 401) { localStorage.removeItem('spotify_access_token'); window.location.reload(); }
                                if (res.status === 429) {
                                    startSpotify429Maintenance(Date.now() + SPOTIFY_429_COOLDOWN_MS);
                                    const err = new Error('Spotify rate limit'); err.status = 429; throw err;
                                }
                                if (!res.ok) { const err = new Error(`API error: ${res.status}`); err.status = res.status; throw err; }
                                if (res.status === 204) result = null;
                                else {
                                    const text = await res.text();
                                    if (!text) result = null;
                                    else {
                                        try { result = JSON.parse(text); } catch (e) { result = null; }
                                    }
                                }
                                break;
                            } catch (error) {
                                if (error instanceof TypeError) handleConnectivityLost();
                                if (error?.status !== 429) throw error;
                                if (isSpotify429MaintenanceActive() || !isGet || attempt >= 2) throw error;
                                await spotifyDelay(Math.max(0, rateLimitUntil - Date.now()));
                            }
                        }
                        handleConnectivityRestored();
                        resolve(result);
                    } catch (error) {
                        reject(error);
                    }
                    await spotifyDelay(MIN_SPOTIFY_REQUEST_INTERVAL_MS);
                }).catch(() => { });
            });
            if (isGet) {
                spotifyGetRequests.set(endpoint, request);
                request.then(
                    () => spotifyGetRequests.delete(endpoint),
                    () => spotifyGetRequests.delete(endpoint)
                );
            }
            return request;
        }
        const getUserProfile = () => fetchWebApi('v1/me');
        const getRecentlyPlayed = () => fetchWebApi('v1/me/player/recently-played?limit=50');
        const getUserTopArtists = () => fetchWebApi('v1/me/top/artists?time_range=short_term&limit=50');
        const getFeaturedPlaylists = () => fetchWebApi('v1/browse/featured-playlists?country=TH&limit=10');
        const getDeveloperSounds = () => rankingApi(null, { action: 'developer_sounds' });
        const searchSpotify = (q) => fetchWebApi(`v1/search?q=${encodeURIComponent(q)}&type=track,artist,album&limit=10`);
        const getArtist = (id) => fetchWebApi(`v1/artists/${id}`);
        // Spotify removed GET /artists/{id}/top-tracks in the Feb 2026 API changes (Dev Mode apps).
        // Fall back to searching tracks by artist name and keeping only ones credited to this artist ID.
        const getArtistTopTracks = async (id, artistName) => {
            const data = await fetchWebApi(`v1/search?q=${encodeURIComponent(`artist:"${artistName}"`)}&type=track&limit=10`);
            const items = data?.tracks?.items || [];
            const filtered = items.filter(t => t.artists?.some(a => a.id === id));
            return { tracks: filtered.length ? filtered : items };
        };
        // The `market` param/field was also removed in that same update — omit it.
        // Spotify's albums endpoint returns 400 if neither `market` nor a user-account country is present,
        // and the account country field was also removed from GET /me — so a hardcoded market is required.
        const DEFAULT_MARKET = 'TH';
        const getArtistAlbums = (id) => fetchWebApi(`v1/artists/${id}/albums?include_groups=album,single&market=${DEFAULT_MARKET}&limit=10`);
        const getAlbum = (id) => fetchWebApi(`v1/albums/${id}?market=${DEFAULT_MARKET}`);
        const getAlbumTracks = (id) => fetchWebApi(`v1/albums/${id}/tracks?market=${DEFAULT_MARKET}&limit=50`);
        const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
        const wikipediaArtistCache = new Map();
        async function getWikipediaArtistData(spotifyArtist) {
            const artistName = spotifyArtist.name.trim();
            const cacheKey = `${spotifyArtist.id || ''}:${artistName.toLocaleLowerCase()}`;
            if (wikipediaArtistCache.has(cacheKey)) return wikipediaArtistCache.get(cacheKey);
            const dataPromise = (async () => {
                const searchWikipedia = async (language, query) => {
                    const searchParams = new URLSearchParams({
                        action: 'query',
                        list: 'search',
                        srsearch: query,
                        srnamespace: '0',
                        srlimit: '8',
                        format: 'json',
                        origin: '*'
                    });
                    const response = await fetch(`https://${language}.wikipedia.org/w/api.php?${searchParams}`);
                    if (!response.ok) throw new Error(`Wikipedia ตอบกลับสถานะ ${response.status}`);
                    const data = await response.json();
                    return (data.query?.search || []).map(result => ({ ...result, language }));
                };
                const searchResults = await Promise.all([
                    searchWikipedia('en', `${artistName} band singer musician`),
                    searchWikipedia('en', `${artistName} ${spotifyArtist.genres?.slice(0, 2).join(' ') || 'music'}`),
                    searchWikipedia('th', `${artistName} วงดนตรี นักร้อง`)
                ]);
                const artistTerms = /\b(band|singer|musician|music group|artist|vocalist)\b|วง\s*ดนตรี|นัก\s*ร้อง|นัก\s*ดนตรี|ศิลปิน/i;
                const normalizedName = artistName.toLocaleLowerCase();
                const candidatesById = new Map();
                searchResults.flat().forEach(result => {
                    const snippet = result.snippet.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'");
                    const title = result.title.trim().toLocaleLowerCase();
                    const titleBase = title.replace(/\s*\([^)]*\)\s*$/, '').trim();
                    const exactTitle = titleBase === normalizedName;
                    const snippetLower = snippet.toLocaleLowerCase();
                    const mentionsArtist = snippetLower.includes(normalizedName);
                    const localizedArtistLead = result.language === 'th'
                        && snippetLower.indexOf(normalizedName) >= 0
                        && snippetLower.indexOf(normalizedName) < 60
                        && /วง\s*ดนตรี|นัก\s*ร้อง|นัก\s*ดนตรี|ศิลปิน/i.test(snippet);
                    if ((!exactTitle && !localizedArtistLead) || !artistTerms.test(snippet)) return;
                    if (/\b(album|song|film|book|list)\b|อัลบั้ม|เพลง/i.test(result.title) && title !== normalizedName) return;
                    const score = (exactTitle ? 10 : 0) + (localizedArtistLead ? 5 : 0) + (mentionsArtist ? 1 : 0);
                    const existing = candidatesById.get(result.pageid);
                    if (!existing || existing.score < score) candidatesById.set(result.pageid, { ...result, score });
                });
                const candidates = [...candidatesById.values()].sort((a, b) => b.score - a.score).slice(0, 8);
                if (!candidates.length) return null;
                const pagesByLanguage = await Promise.all(['en', 'th'].map(async language => {
                    const pageIds = candidates.filter(candidate => candidate.language === language).map(candidate => candidate.pageid);
                    if (!pageIds.length) return [];
                    const params = new URLSearchParams({
                        action: 'query',
                        pageids: pageIds.join('|'),
                        prop: 'extracts|pageimages|info',
                        exintro: '1',
                        explaintext: '1',
                        piprop: 'thumbnail',
                        pithumbsize: '500',
                        inprop: 'url',
                        format: 'json',
                        origin: '*'
                    });
                    const response = await fetch(`https://${language}.wikipedia.org/w/api.php?${params}`);
                    if (!response.ok) throw new Error(`Wikipedia ตอบกลับสถานะ ${response.status}`);
                    const data = await response.json();
                    return Object.values(data.query?.pages || {}).map(page => ({ ...page, language }));
                }));
                const pages = pagesByLanguage.flat();
                return candidates
                    .map(candidate => pages.find(page => String(page.pageid) === String(candidate.pageid)))
                    .find(page => page?.extract && artistTerms.test(page.extract)) || null;
            })();
            wikipediaArtistCache.set(cacheKey, dataPromise);
            dataPromise.catch(() => wikipediaArtistCache.delete(cacheKey));
            return dataPromise;
        }
        async function loadWikipediaArtistInfo(spotifyArtist) {
            const modal = document.createElement('section');
            modal.className = 'wikipedia-artist-overlay';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'wikipedia-artist-title');
            const dialog = document.createElement('div');
            dialog.className = 'wikipedia-artist-dialog';
            const heading = document.createElement('h2');
            heading.id = 'wikipedia-artist-title';
            heading.textContent = `เกี่ยวกับ ${spotifyArtist.name}`;
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'wikipedia-artist-close';
            close.setAttribute('aria-label', 'ปิดข้อมูลศิลปิน');
            close.textContent = '×';
            const content = document.createElement('div');
            content.className = 'wikipedia-artist-content';
            content.setAttribute('aria-live', 'polite');
            content.textContent = 'กำลังค้นหาข้อมูลจาก Wikipedia...';
            const source = document.createElement('a');
            source.className = 'wikipedia-artist-source hidden';
            source.target = '_blank';
            source.rel = 'noopener noreferrer';
            source.textContent = 'อ่านเพิ่มเติมใน Wikipedia';
            const dismiss = () => modal.remove();
            close.onclick = dismiss;
            modal.onclick = event => { if (event.target === modal) dismiss(); };
            dialog.append(close, heading, content, source);
            modal.appendChild(dialog);
            document.body.appendChild(modal);
            close.focus();

            try {
                const info = await getWikipediaArtistData(spotifyArtist);
                if (!info) throw new Error('ไม่พบบทความศิลปินนี้ใน Wikipedia');
                content.replaceChildren();
                if (info.thumbnail?.source) {
                    const image = document.createElement('img');
                    image.className = 'wikipedia-artist-image';
                    image.src = info.thumbnail.source;
                    image.alt = `ภาพของ ${info.title}`;
                    content.appendChild(image);
                }
                const extract = document.createElement('p');
                extract.textContent = info.extract;
                content.appendChild(extract);
                source.href = info.fullurl;
                source.classList.remove('hidden');
            } catch (error) {
                console.error('Wikipedia artist info error:', error);
                content.textContent = error.message || 'โหลดข้อมูลศิลปินจาก Wikipedia ไม่สำเร็จ';
            }
        }
        // Follow/unfollow artist:
        // 1) ลอง endpoint ใหม่ /me/library (uris อยู่ใน query string)
        // 2) ถ้าไม่รองรับ artist (400/403/404) ให้ fallback ไป /me/following แบบเดิม
        const artistUri = (id) => `spotify:artist:${id}`;
        const canFallback = (e) => [400, 403, 404].includes(e?.status);
        const checkFollowsArtist = async (artistId) => {
            try {
                const data = await fetchWebApi(`v1/me/library/contains?uris=${encodeURIComponent(artistUri(artistId))}`);
                return Array.isArray(data) ? !!data[0] : false;
            } catch (e) {
                if (!canFallback(e)) throw e;
                try {
                    const data = await fetchWebApi(`v1/me/following/contains?type=artist&ids=${artistId}`);
                    return Array.isArray(data) ? !!data[0] : false;
                } catch (e2) { throw e; }
            }
        };
        const followArtist = async (artistId) => {
            try { return await fetchWebApi(`v1/me/library?uris=${encodeURIComponent(artistUri(artistId))}`, 'PUT'); }
            catch (e) {
                if (!canFallback(e)) throw e;
                try { return await fetchWebApi(`v1/me/following?type=artist&ids=${artistId}`, 'PUT'); } catch (e2) { throw e; }
            }
        };
        const unfollowArtist = async (artistId) => {
            try { return await fetchWebApi(`v1/me/library?uris=${encodeURIComponent(artistUri(artistId))}`, 'DELETE'); }
            catch (e) {
                if (!canFallback(e)) throw e;
                try { return await fetchWebApi(`v1/me/following?type=artist&ids=${artistId}`, 'DELETE'); } catch (e2) { throw e; }
            }
        };

        // ============================================================
        // PLAYER
        // ============================================================
        let deviceId, _onStateChange, _onReady;
        // เล่นเสียงบนอุปกรณ์อื่นผ่าน Spotify Connect (เช่น ทีวี): remote.id ว่าง = เล่นบนเบราว์เซอร์นี้
        const remote = { id: '', name: '', timer: null, last: null };
        window.sdkIsReady = false;
        window.pendingInit = null;
        window.onSpotifyWebPlaybackSDKReady = () => {
            window.sdkIsReady = true;
            if (window.pendingInit) { window.pendingInit(); window.pendingInit = null; }
        };

        // Dynamically load the Spotify Web Playback SDK
        const spotifyScript = document.createElement('script');
        spotifyScript.src = "https://sdk.scdn.co/spotify-player.js";
        document.head.appendChild(spotifyScript);

        function initSpotifyPlayer(token, onStateChange, onReady) {
            _onStateChange = onStateChange; _onReady = onReady;
            const setup = () => {
                const player = new Spotify.Player({ name: 'R Music Web Player', getOAuthToken: cb => { cb(token); }, volume: 0.5 });
                player.addListener('initialization_error', ({ message }) => { console.error('Init error:', message); showToast('❌ ไม่สามารถเริ่ม Player ได้', 'error'); });
                player.addListener('authentication_error', ({ message }) => { console.error('Auth error:', message); localStorage.removeItem('spotify_access_token'); setTimeout(() => window.location.reload(), 2000); });
                player.addListener('account_error', () => showPremiumRequiredModal());
                player.addListener('playback_error', ({ message }) => { console.error('Playback error:', message); showToast('❌ เกิดข้อผิดพลาดในการเล่นเพลง', 'error'); });
                player.addListener('player_state_changed', state => { if (remote.id) return; /* กำลังเล่นบนอุปกรณ์อื่น ไม่ให้สถานะของเครื่องนี้มาทับ */ if (_onStateChange) _onStateChange(state); });
                player.addListener('ready', ({ device_id }) => { deviceId = device_id; transferPlaybackHere(device_id); if (_onReady) _onReady(); showToast('✅ Player พร้อมใช้งานแล้ว!', 'info'); });
                player.addListener('not_ready', ({ device_id }) => { console.log('Device offline:', device_id); });
                player.connect();
                window._spotifyPlayer = player;
            };
            if (window.sdkIsReady) setup(); else window.pendingInit = setup;
        }
        async function transferPlaybackHere(device_id) {
            try { await fetchWebApi('v1/me/player', 'PUT', { device_ids: [device_id], play: false }); } catch (e) { }
        }
        async function playTrack(uri, contextUri) {
            if (!isPremium) { showToast('⚠️ ต้องใช้ Spotify Premium เพื่อเล่นเพลง', 'warning'); return; }
            if (!deviceId) { showToast('⚠️ Player ยังไม่พร้อม กรุณารอสักครู่', 'warning'); return; }
            setPlayLoading(true); // แสดงอนิเมชันโหลดทันทีที่กดเล่น จนกว่าเพลงจะเริ่มเล่นจริง (state เปลี่ยน)
            try {
                let trackId = null;
                if (uri && uri.startsWith('spotify:track:')) {
                    trackId = uri.split(':')[2];
                } else if (contextUri && contextUri.startsWith('spotify:track:')) {
                    trackId = contextUri.split(':')[2];
                }

                if (trackId && (!currentTrackData || currentTrackData.id !== trackId)) {
                    try {
                        const track = await fetchWebApi(`v1/tracks/${trackId}`);
                        if (track) {
                            currentTrackData = track;
                            await setupLyricsComponent(track);
                        }
                    } catch (e) { console.error("Error preloading lyrics", e); }
                }

                const body = contextUri ? { context_uri: contextUri, ...(uri ? { offset: { uri } } : {}) } : { uris: [uri] };
                await fetchWebApi(`v1/me/player/play?device_id=${remote.id || deviceId}`, 'PUT', body);
            } catch (e) {
                setPlayLoading(false);
                if (e && e.status !== 429) showToast('❌ ไม่สามารถเล่นเพลงนี้ได้', 'error');
            }
        }
        async function playTrackSequence(tracks, startUri, shuffle = false) {
            if (!isPremium) { showToast('⚠️ ต้องใช้ Spotify Premium เพื่อเล่นเพลง', 'warning'); return; }
            if (!deviceId) { showToast('⚠️ Player ยังไม่พร้อม กรุณารอสักครู่', 'warning'); return; }
            const queue = (tracks || []).filter(track => track?.uri?.startsWith('spotify:track:'));
            if (!queue.length) { showToast('ไม่พบเพลงที่เล่นได้ในรายการนี้', 'warning'); return; }
            if (shuffle) {
                for (let i = queue.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [queue[i], queue[j]] = [queue[j], queue[i]];
                }
            } else if (startUri) {
                const startIndex = queue.findIndex(track => track.uri === startUri);
                if (startIndex > 0) queue.splice(0, startIndex);
            }

            setPlayLoading(true);
            try {
                await fetchWebApi(`v1/me/player/play?device_id=${remote.id || deviceId}`, 'PUT', {
                    uris: queue.map(track => track.uri),
                    offset: { position: 0 }
                });
            } catch (error) {
                setPlayLoading(false);
                if (error && error.status !== 429) {
                    console.error('Track sequence playback error:', error);
                    showToast('❌ ไม่สามารถเล่นรายการเพลงนี้ได้', 'error');
                }
            }
        }

        function setPlayLoading(on) {
            document.querySelectorAll('.btn-play').forEach(b => b.classList.toggle('is-loading', on));
        }
        async function remoteCmd(kind, arg) {
            const q = `device_id=${encodeURIComponent(remote.id)}`;
            try {
                if (kind === 'play') await fetchWebApi(`v1/me/player/play?${q}`, 'PUT');
                else if (kind === 'pause') await fetchWebApi(`v1/me/player/pause?${q}`, 'PUT');
                else if (kind === 'next') await fetchWebApi(`v1/me/player/next?${q}`, 'POST');
                else if (kind === 'previous') await fetchWebApi(`v1/me/player/previous?${q}`, 'POST');
                else if (kind === 'seek') await fetchWebApi(`v1/me/player/seek?position_ms=${Math.round(arg)}&${q}`, 'PUT');
                setTimeout(pollRemote, 600);
            } catch (e) { console.error('Remote command error:', e); showToast('❌ สั่งอุปกรณ์ปลายทางไม่สำเร็จ', 'error'); }
        }
        const togglePlay = () => { if (remote.id) return remoteCmd(seekState.paused ? 'play' : 'pause'); if (window._spotifyPlayer) window._spotifyPlayer.togglePlay(); };
        const nextTrack = () => { if (remote.id) return remoteCmd('next'); if (window._spotifyPlayer) window._spotifyPlayer.nextTrack(); };
        const previousTrack = () => { if (remote.id) return remoteCmd('previous'); if (window._spotifyPlayer) window._spotifyPlayer.previousTrack(); };
        const playbackResume = () => remote.id ? remoteCmd('play') : window._spotifyPlayer?.resume();
        const playbackPause = () => remote.id ? remoteCmd('pause') : window._spotifyPlayer?.pause();
        const playbackSeek = ms => remote.id ? remoteCmd('seek', ms) : window._spotifyPlayer?.seek(ms);

        // ============================================================
        // ออฟไลน์: ไม่มีสัญญาณอินเทอร์เน็ต/มือถือ -> ขึ้นสปินเนอร์เต็มจอกันสับสนว่าค้าง
        // พอสัญญาณกลับมา ถ้าตอนหลุดสัญญาณกำลังเล่นเพลงอยู่ ก็สั่งเล่นต่อให้อัตโนมัติ
        // ตรวจจับ 2 ทาง: 1) event online/offline ของเบราว์เซอร์ (เร็ว แต่บางเว็บวิวในแอปยิงไม่แม่นยำ)
        // 2) เจอ error จริงตอนยิง Spotify API (fetchWebApi ด้านบนเรียก handleConnectivityLost ให้เอง) แล้ว
        //    คอยเช็คสัญญาณซ้ำเป็นระยะจนกว่าจะกลับมาใช้ได้จริง — ใช้วิธีนี้เป็นหลักเพราะแม่นยำกว่า
        // ============================================================
        let _wasPlayingBeforeOffline = false;
        let _connectivityLost = false;
        let _connectivityRetryTimer = null;
        function showOfflineOverlay() { document.getElementById('offline-overlay')?.classList.remove('hidden'); }
        function hideOfflineOverlay() { document.getElementById('offline-overlay')?.classList.add('hidden'); }
        function handleConnectivityLost() {
            if (_connectivityLost) return;
            _connectivityLost = true;
            _wasPlayingBeforeOffline = !seekState.paused; // จำสถานะไว้ก่อนหลุด จะได้รู้ว่าต้องเล่นต่อไหมตอนกลับมา
            showOfflineOverlay();
            clearInterval(_connectivityRetryTimer);
            _connectivityRetryTimer = setInterval(async () => {
                try { await fetch('https://api.spotify.com/v1/', { method: 'HEAD', mode: 'no-cors' }); handleConnectivityRestored(); }
                catch (e) { /* ยังไม่มีสัญญาณ ลองใหม่รอบหน้า */ }
            }, 3000);
        }
        function handleConnectivityRestored() {
            clearInterval(_connectivityRetryTimer); _connectivityRetryTimer = null;
            if (!_connectivityLost) return;
            _connectivityLost = false;
            hideOfflineOverlay();
            // รอสักครู่ให้เครือข่ายนิ่งจริงๆ ก่อนสั่งเล่นต่อ (สัญญาณกลับมาใหม่ๆ มักยังไม่เสถียรพอจะยิง API ทันที)
            if (_wasPlayingBeforeOffline) { _wasPlayingBeforeOffline = false; setTimeout(() => playbackResume(), 1200); }
        }
        window.addEventListener('offline', handleConnectivityLost);
        window.addEventListener('online', handleConnectivityRestored);
        if (!navigator.onLine) handleConnectivityLost(); // เผื่อเปิดเว็บมาตอนไม่มีสัญญาณอยู่แล้วตั้งแต่แรก

        // ============================================================
        // เชื่อมกับแอปเนทีฟสำหรับ Android Auto / CarPlay
        // ============================================================
        // เว็บหน้านี้แสดงผล "จอเล่นเพลง" ได้เฉยๆ แต่ Android Auto (ต้องมี MediaBrowserServiceCompat ของแอป Android)
        // และ CarPlay (ต้องมี MPNowPlayingInfoCenter/MPRemoteCommandCenter + สิทธิ์ CarPlay ของแอป iOS) เป็นการแสดงผล/
        // ควบคุมที่ระบบปฏิบัติการวาดขึ้นเองบนจอรถ ซึ่งต้องเขียนโค้ดฝั่งแอปเนทีฟ (Kotlin/Swift) เชื่อมเข้ามา — ทำจากไฟล์เว็บ
        // อย่างเดียวไม่ได้ สิ่งที่ทำได้จากฝั่งนี้คือเปิด "สะพาน" ให้ฝั่งแอปเนทีฟยิงคำสั่งเข้ามา และรับข้อมูลเพลงที่กำลังเล่นออกไป
        // หมายเหตุ: ไฟล์นี้โหลดแบบ ES module ตัวแปร/ฟังก์ชันระดับบนสุดจะไม่ติด window ให้อัตโนมัติเหมือนสคริปต์ทั่วไป
        // จึงต้อง export ฟังก์ชันควบคุมออกมาที่ window ตรงๆ เพื่อให้ฝั่งแอปเนทีฟยิงเข้ามาได้ (เช่น
        // webView.evaluateJavascript("window.carTogglePlay()") บน Android หรือ webView.evaluateJavaScript(...) บน iOS)
        window.carTogglePlay = () => togglePlay();
        window.carPlay = () => playbackResume();
        window.carPause = () => playbackPause();
        window.carNext = () => nextTrack();
        window.carPrevious = () => previousTrack();
        window.carSeekTo = ms => playbackSeek(Number(ms) || 0);
        // ฝั่งแอปเนทีฟกำหนด window.onCarPlaybackChange = function(info) {...} เอง (ก่อนโหลดเว็บนี้เสร็จก็ได้ ฟังก์ชันนี้
        // จะถูกเรียกซ้ำทุกครั้งที่สถานะเปลี่ยนอยู่แล้ว) แล้วรับข้อมูลเพลงปัจจุบันเป็น plain object ไปอัปเดต
        // MediaBrowserServiceCompat (Android Auto) หรือ MPNowPlayingInfoCenter (CarPlay) ต่อในโค้ดเนทีฟ
        function notifyCarPlaybackChange(state) {
            if (typeof window.onCarPlaybackChange !== 'function') return;
            const track = state?.track_window?.current_track; if (!track) return;
            try {
                window.onCarPlaybackChange({
                    title: track.name,
                    artist: track.artists.map(a => a.name).join(', '),
                    album: track.album?.name || '',
                    artworkUrl: track.album?.images?.[0]?.url || '',
                    isPlaying: !state.paused,
                    positionMs: state.position,
                    durationMs: state.duration,
                });
            } catch (e) { console.error('onCarPlaybackChange error:', e); }
        }

        // ---------- เล่นเสียงบนอุปกรณ์อื่น (Spotify Connect) ----------
        // แปลงผลจาก GET /v1/me/player ให้อยู่ในรูปเดียวกับสถานะของ Web Playback SDK เพื่อใช้ UI/เนื้อเพลง/แชร์ TV ชุดเดิม
        function stateFromApi(d) {
            const item = d?.item; if (!item || item.type !== 'track') return null;
            const age = d.timestamp ? Math.min(3000, Math.max(0, Date.now() - d.timestamp)) : 0; // ข้อมูลจาก API เก่าไปกี่ ms
            const position = Math.min(item.duration_ms, (d.progress_ms || 0) + (d.is_playing ? age : 0));
            return { track_window: { current_track: item }, position, duration: item.duration_ms, paused: !d.is_playing };
        }

        async function pollRemote() {
            if (!remote.id) return;
            try {
                const d = await fetchWebApi('v1/me/player');
                if (!remote.id || !d || !d.device) return;
                if (d.device.id === deviceId) { leaveRemote(); return; }                       // ผู้ใช้สลับกลับมาเล่นบนเครื่องนี้ (เช่นจากแอป Spotify)
                if (d.device.id !== remote.id) { remote.id = d.device.id; remote.name = d.device.name; remoteUiRefresh(); } // ไปเล่นบนอุปกรณ์อื่นจากแอป Spotify
                const st = stateFromApi(d); if (!st) return;
                const track = st.track_window.current_track, now = performance.now(), prev = remote.last;
                const expected = prev ? (prev.paused ? prev.position : prev.position + (now - prev.at)) : -1;
                const changed = !prev || prev.id !== track.id || prev.paused !== st.paused || Math.abs(expected - st.position) > 1500;
                remote.last = { id: track.id, paused: st.paused, position: st.position, at: now };
                if (changed) handlePlayerStateChange(st); else syncSeekFromState(st);
            } catch (e) { if (e.status !== 429) console.error('Remote poll error:', e); }
        }

        function enterRemote(dev) {
            remote.id = dev.id; remote.name = dev.name; remote.last = null;
            clearInterval(remote.timer); remote.timer = setInterval(pollRemote, 4000); // ยืดจังหวะเรียก Spotify ลง ลดโอกาสโดน 429
            remoteUiRefresh(); setTimeout(pollRemote, 800);
        }
        function leaveRemote() {
            clearInterval(remote.timer); remote.id = ''; remote.name = ''; remote.last = null;
            remoteUiRefresh();
            window._spotifyPlayer?.getCurrentState?.().then(st => { if (st) handlePlayerStateChange(st); }).catch(() => { });
        }
        async function transferToDevice(dev) {
            const wasPlaying = !seekState.paused && seekState.duration > 0;
            try { await fetchWebApi('v1/me/player', 'PUT', { device_ids: [dev.id], play: wasPlaying }); }
            catch (e) {
                console.error('Transfer error:', e);
                showToast(e.status === 404 ? '❌ ไม่พบอุปกรณ์นี้แล้ว ลองกดค้นหาใหม่' : e.status === 403 ? '❌ อุปกรณ์นี้ไม่รับคำสั่งจาก Spotify' : '❌ สลับอุปกรณ์ไม่สำเร็จ', 'error');
                return;
            }
            if (dev.id === deviceId) leaveRemote(); else enterRemote(dev);
            showToast(dev.id === deviceId ? '🔊 เล่นเสียงบนเครื่องนี้' : `🔊 เล่นเสียงบน ${dev.name}`, 'info');
        }

        // กล่องข้อความกลางจอ พร้อมปุ่ม "สลับบัญชี" / "ออกจากระบบ" เสมอ — กันเคสที่แอปใช้งานไม่ได้แล้วออกจากระบบไม่ได้
        function showAccountModal({ id = 'account-modal', icon = 'ℹ️', title, html, closable = false, retry = false }) {
            document.getElementById(id)?.remove();
            const overlay = document.createElement('div');
            overlay.id = id;
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(5px);z-index:3000;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = `<div class="glass-panel" style="padding:2.2rem;border-radius:24px;text-align:center;max-width:440px;width:90%;max-height:90vh;overflow-y:auto;background:rgba(25,25,30,.95);">
    <div style="font-size:2.6rem;margin-bottom:.8rem">${icon}</div>
    <h2 style="font-size:1.4rem;margin-bottom:.9rem;color:#fff">${title}</h2>
    <div style="color:#a0a0a5;line-height:1.7;margin-bottom:1.6rem;font-size:.95rem;text-align:left">${html}</div>
    <div class="account-modal-btns" style="display:flex;flex-direction:column;gap:.6rem"></div>
  </div>`;
            const box = overlay.querySelector('.account-modal-btns');
            const mk = (label, bg, color, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.style.cssText = `background:${bg};color:${color};border:none;padding:.85rem 1.5rem;border-radius:14px;cursor:pointer;font:inherit;font-weight:600;font-size:.95rem;`; b.addEventListener('click', fn); box.appendChild(b); };
            if (retry) mk('🔁 ลองใหม่', '#1db954', '#fff', () => window.location.reload());
            if (closable) mk('ดูเพลงต่อ (ไม่ฟังเพลง)', 'rgba(255,255,255,.12)', '#fff', () => overlay.remove());
            mk('🔄 สลับบัญชี', 'rgba(255,255,255,.12)', '#fff', switchAccount);
            mk('🚪 ออกจากระบบ', 'rgba(255,107,107,.15)', '#ff6b6b', logout);
            document.body.appendChild(overlay);
        }
        // บัญชี Free: Spotify ไม่อนุญาตให้เล่นเพลงผ่านเว็บ (Web Playback SDK ต้องใช้ Premium)
        function showPremiumRequiredModal() {
            isPremium = false;
            document.getElementById('player-screen')?.classList.add('hidden');
            showAccountModal({
                id: 'premium-modal', icon: '🎵', title: 'ต้องใช้ Spotify Premium เพื่อฟังเพลง', closable: true,
                html: 'บัญชีนี้เป็นแบบ <strong style="color:#fff">Free</strong> ซึ่ง Spotify ไม่อนุญาตให้เล่นเพลงผ่านเว็บเพลเยอร์ได้<br><br>คุณยังค้นหาและเรียกดูศิลปิน/อัลบั้มได้ แต่จะกดเล่นเพลงไม่ได้ ถ้าต้องการฟัง ให้สลับไปใช้บัญชี Premium หรืออัปเกรดที่ <a href="https://www.spotify.com/premium/" target="_blank" rel="noopener" style="color:#1ed760">spotify.com/premium</a>'
            });
        }
        // เข้าถึงข้อมูลบัญชีไม่ได้ (เช่น 403 เพราะยังไม่ได้เพิ่มบัญชีในแอป Development Mode)
        function showAccessError(e) {
            if (e?.status === 403) {
                showAccountModal({
                    id: 'access-error-modal', icon: '🔒', title: 'บัญชีนี้ยังใช้งานแอปไม่ได้',
                    html: 'Spotify ปฏิเสธการเข้าถึง (403) เพราะแอปนี้อยู่ใน <strong style="color:#fff">Development Mode</strong> ซึ่งอนุญาตเฉพาะบัญชีที่เจ้าของแอปเพิ่มไว้ (สูงสุด 5 คน)<br><br><strong style="color:#fff">วิธีแก้:</strong> เจ้าของแอปเข้า <em>developer.spotify.com/dashboard</em> → เลือกแอป → <em>User Management</em> → เพิ่มชื่อและอีเมลของบัญชีนี้ แล้วล็อกอินใหม่ หรือสลับไปใช้บัญชีอื่น'
                });
            } else {
                showAccountModal({
                    id: 'access-error-modal', icon: '⚠️', title: 'โหลดข้อมูลไม่สำเร็จ', retry: true,
                    html: `เกิดข้อผิดพลาดขณะเชื่อมต่อ Spotify${e?.message ? ` (${String(e.message).replace(/[<>&]/g, '')})` : ''}<br>ลองใหม่อีกครั้ง หรือสลับ/ออกจากระบบแล้วเข้าใหม่`
                });
            }
        }

        // ============================================================
        // UI
        // ============================================================
        function showScreen(id) { document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden')); document.getElementById(id).classList.remove('hidden'); }
        function updateTopNavIndicator() {
            const tabs = document.getElementById('top-nav-tabs');
            const activeTab = tabs?.querySelector('.top-nav-tab.active');
            if (!tabs || !activeTab) return;
            const tabsRect = tabs.getBoundingClientRect();
            const activeRect = activeTab.getBoundingClientRect();
            tabs.style.setProperty('--active-tab-x', `${activeRect.left - tabsRect.left + tabs.scrollLeft}px`);
            tabs.style.setProperty('--active-tab-width', `${activeRect.width}px`);
        }
        function showView(viewId) {
            document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
            document.getElementById(viewId).classList.add('active');
            document.getElementById('app-screen').classList.toggle('artist-page-active', viewId === 'view-artist');
            document.getElementById('search-bar-container').classList.toggle('hidden', viewId !== 'view-search');
            const target = viewId.replace('view-', '');
            document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.target === target));
            // sync mobile top nav tabs
            document.querySelectorAll('.top-nav-tab').forEach(el => el.classList.toggle('active', el.dataset.target === target));
            updateTopNavIndicator();
            document.getElementById('btn-top-search')?.classList.toggle('active', viewId === 'view-search');
            // sync drawer nav items
            const drawerLabels = { search: 'ค้นหา', ranking: 'จัดอันดับ', playlists: 'เพลย์ลิสต์' };
            document.querySelectorAll('.drawer-nav-item').forEach(el => {
                el.classList.toggle('active', el.dataset.target === target);
                const label = el.querySelector('span');
                if (label && drawerLabels[el.dataset.target]) label.textContent = drawerLabels[el.dataset.target];
            });
            if (viewId === 'view-ranking') startRankingView(); else stopRankingView();
            if (viewId === 'view-playlists') loadMyPlaylists();
        }
        function renderUserProfile(profile) {
            const container = document.getElementById('user-profile');
            const name = profile.display_name || profile.id || 'User';
            const imageUrl = profile.images?.length ? profile.images[0].url : '';
            container.innerHTML = '';

            const btn = document.createElement('button');
            btn.type = 'button'; btn.className = 'user-profile-btn'; btn.title = 'บัญชีของฉัน';
            btn.setAttribute('aria-haspopup', 'menu');

            let avatar;
            if (imageUrl) { avatar = document.createElement('img'); avatar.src = imageUrl; avatar.alt = ''; }
            else { avatar = document.createElement('div'); avatar.className = 'avatar-fallback'; avatar.textContent = name.charAt(0).toUpperCase(); }
            const label = document.createElement('span'); label.className = 'user-name'; label.textContent = name;
            const chevron = document.createElement('span'); chevron.className = 'user-chevron'; chevron.textContent = '▴';
            btn.append(avatar, label, chevron);
            container.appendChild(btn);

            // Render user info in mobile drawer too
            const drawerUser = document.getElementById('drawer-user-profile');
            if (drawerUser) {
                drawerUser.innerHTML = '';
                const drawerBtn = document.createElement('button');
                drawerBtn.type = 'button'; drawerBtn.className = 'user-profile-btn'; drawerBtn.title = 'บัญชีของฉัน';
                let drawerAvatar;
                if (imageUrl) { drawerAvatar = document.createElement('img'); drawerAvatar.src = imageUrl; drawerAvatar.alt = ''; drawerAvatar.style.cssText = 'width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;'; }
                else { drawerAvatar = document.createElement('div'); drawerAvatar.className = 'avatar-fallback'; drawerAvatar.textContent = name.charAt(0).toUpperCase(); drawerAvatar.style.cssText = 'width:40px;height:40px;'; }
                const drawerInfo = document.createElement('div'); drawerInfo.className = 'drawer-user-info';
                const drawerName = document.createElement('span'); drawerName.className = 'drawer-user-name'; drawerName.textContent = name;
                const drawerSub = document.createElement('span'); drawerSub.className = 'drawer-user-sub'; drawerSub.textContent = 'ดูบัญชีและการตั้งค่า';
                drawerInfo.append(drawerName, drawerSub);
                drawerBtn.append(drawerAvatar, drawerInfo);
                drawerUser.appendChild(drawerBtn);
                drawerBtn.addEventListener('click', () => { btn.click(); });
            }

            // เมนูบัญชี (สร้างครั้งเดียว)
            let menu = document.getElementById('account-menu');
            if (menu) menu.remove();
            menu = document.createElement('div');
            menu.id = 'account-menu'; menu.className = 'account-menu hidden'; menu.setAttribute('role', 'menu');
            menu.innerHTML = `
    <div class="account-menu-header"></div>
    <button type="button" class="account-menu-item" id="menu-switch-account" role="menuitem">🔄 สลับบัญชี</button>
    <button type="button" class="account-menu-item danger" id="menu-logout" role="menuitem">🚪 ออกจากระบบ</button>`;
            menu.querySelector('.account-menu-header').textContent = name;
            document.body.appendChild(menu);

            const closeMenu = () => menu.classList.add('hidden');
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!menu.classList.contains('hidden')) { closeMenu(); return; }
                menu.classList.remove('hidden');
                const mobileAnchor = window.matchMedia('(max-width: 768px)').matches
                    ? document.getElementById('btn-top-more')
                    : null;
                const r = (mobileAnchor?.getClientRects().length ? mobileAnchor : btn).getBoundingClientRect();
                menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
                menu.style.bottom = `${window.innerHeight - r.bottom + 8}px`;
            });
            document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeMenu(); });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
            menu.querySelector('#menu-switch-account').addEventListener('click', () => { closeMenu(); switchAccount(); });
            menu.querySelector('#menu-logout').addEventListener('click', () => { closeMenu(); logout(); });
        }
        // การ์ดใหญ่ 2 ใบด้านบนสุดของหน้าหลัก (คล้าย Apple Music) ใช้เพลงที่ฟังล่าสุด 2 เพลง
        function renderHeroBanner(historyData, onPlay) {
            const box = document.getElementById('hero-banner'); if (!box) return;
            box.innerHTML = '';
            const tracks = (historyData?.items || []).map(i => i.track).filter((t, idx, arr) => t && arr.findIndex(x => x.uri === t.uri) === idx).slice(0, 2);
            if (!tracks.length) { box.classList.add('hidden'); return; }
            box.classList.remove('hidden');
            tracks.forEach((t, i) => {
                const card = document.createElement('div'); card.className = 'hero-card';
                const img = t.album?.images?.[0]?.url || '';
                card.style.backgroundImage = img ? `url("${img}")` : '';
                const tag = document.createElement('div'); tag.className = 'hero-tag'; tag.textContent = i === 0 ? 'ฟังล่าสุด' : 'ฟังต่อ';
                const info = document.createElement('div'); info.className = 'hero-info';
                const title = document.createElement('div'); title.className = 'hero-title'; title.textContent = t.name;
                const sub = document.createElement('div'); sub.className = 'hero-sub'; sub.textContent = t.artists.map(a => a.name).join(', ');
                info.append(title, sub);
                const play = document.createElement('button'); play.type = 'button'; play.className = 'hero-play'; play.setAttribute('aria-label', 'เล่น');
                play.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8,5.14V19.14L19,12.14L8,5.14Z"/></svg>';
                play.onclick = e => { e.stopPropagation(); onPlay(t.uri); };
                card.append(tag, info, play);
                card.onclick = () => onPlay(t.uri);
                box.appendChild(card);
            });
        }

        // เพลย์ลิสต์ของฉันเท่านั้น (ไม่รวมที่ไปติดตามคนอื่น) เรียงคล้ายอัลบัมในหน้าค้นหา
        async function loadMyPlaylists() {
            const box = document.getElementById('my-playlists-grid'); if (!box) return;
            box.innerHTML = '<div class="empty-hint">กำลังโหลด...</div>';
            try {
                const user = await getUserProfile();
                const data = await fetchWebApi('v1/me/playlists?limit=50');
                const mine = (data?.items || []).filter(p => p && p.owner?.id === user.id);
                box.innerHTML = '';
                if (!mine.length) { box.innerHTML = '<div class="empty-hint">คุณยังไม่มีเพลย์ลิสต์ของตัวเอง</div>'; return; }
                mine.forEach(p => {
                    const div = document.createElement('div'); div.className = 'album-card playlist-card';
                    const img = p.images?.[0]?.url || '';
                    div.innerHTML = `<img src="${img}" alt="${p.name}"><div class="playlist-title">${p.name}</div><div class="playlist-owner">${p.tracks?.total || 0} เพลง</div>`;
                    div.onclick = () => playTrack(undefined, p.uri);
                    box.appendChild(div);
                });
            } catch (e) { console.error('My playlists error:', e); box.innerHTML = '<div class="empty-hint">โหลดเพลย์ลิสต์ไม่สำเร็จ</div>'; }
        }

        function renderHistory(historyData, onPlay) {
            const container = document.getElementById('history-grid'); container.innerHTML = '';
            if (!historyData?.items) return;
            const unique = []; const uris = new Set();
            for (const item of historyData.items) { if (!uris.has(item.track.uri)) { uris.add(item.track.uri); unique.push(item.track); } }
            unique.slice(0, 12).forEach(track => {
                if (!track) return;
                const div = document.createElement('div'); div.className = 'history-card playlist-card';
                div.innerHTML = `<img src="${track.album.images[0]?.url}" alt="${track.name}"><div class="playlist-title">${track.name}</div><div class="playlist-owner">${track.artists.map(a => a.name).join(', ')}</div>`;
                div.onclick = () => onPlay(track.uri);
                div.oncontextmenu = (e) => { e.preventDefault(); if (window.showTrackContextMenu) window.showTrackContextMenu(e, track); };
                container.appendChild(div);
            });
        }

        async function loadHomeCollections() {
            const artistsBox = document.getElementById('home-top-artists');
            const playlistsBox = document.getElementById('home-personalized-playlists');
            const developerSoundsBox = document.getElementById('developer-sounds');
            if (!artistsBox || !playlistsBox) return;
            artistsBox.replaceChildren(replayCreateText('div', 'home-collection-loading', 'กำลังโหลดศิลปิน...'));
            playlistsBox.replaceChildren(replayCreateText('div', 'home-collection-loading', 'กำลังโหลดเพลย์ลิสต์...'));
            developerSoundsBox?.replaceChildren(replayCreateText('div', 'home-collection-loading', 'กำลังโหลดรายการที่ผู้พัฒนาคัดสรร...'));

            const [artistsResult, featuredResult, developerSoundsResult] = await Promise.allSettled([
                getUserTopArtists(),
                getFeaturedPlaylists(),
                getDeveloperSounds()
            ]);

            artistsBox.replaceChildren();
            if (artistsResult.status === 'fulfilled' && artistsResult.value?.items?.length) {
                artistsResult.value.items.slice(0, 10).forEach(artist => {
                    const card = document.createElement('button');
                    card.type = 'button';
                    card.className = 'home-artist-card';
                    const image = document.createElement('img');
                    const imageUrl = artist.images?.[0]?.url;
                    if (imageUrl) image.src = imageUrl;
                    image.alt = '';
                    image.loading = 'lazy';
                    const name = replayCreateText('strong', '', artist.name);
                    const subtitle = replayCreateText('span', '', 'ศิลปิน');
                    card.append(image, name, subtitle);
                    card.addEventListener('click', () => handleArtistClick(artist.id));
                    artistsBox.appendChild(card);
                });
            } else {
                artistsBox.appendChild(replayCreateText('div', 'home-collection-loading', 'ยังไม่มีข้อมูลศิลปินยอดนิยม'));
                if (artistsResult.status === 'rejected') console.error('Top artists error:', artistsResult.reason);
            }

            playlistsBox.replaceChildren();
            let playlists = featuredResult.status === 'fulfilled' ? featuredResult.value?.playlists?.items || [] : [];
            let playlistSource = 'featured';
            if (!playlists.length) {
                if (featuredResult.status === 'rejected') {
                    const status = featuredResult.reason?.status;
                    if (status !== 403 && status !== 404) {
                        console.warn('Spotify featured playlists unavailable; trying the user playlist library:', featuredResult.reason);
                    }
                }
                try {
                    const library = await fetchWebApi('v1/me/playlists?limit=50');
                    playlists = library?.items || [];
                    playlistSource = 'library';
                } catch (error) {
                    console.warn('Spotify playlist library fallback failed:', error);
                    const status = error?.status;
                    const message = status === 403
                        ? 'Spotify ไม่อนุญาตให้อ่านเพลย์ลิสต์ กรุณาเชื่อมต่อบัญชีใหม่และอนุญาตสิทธิ์ Playlist'
                        : status === 429
                            ? 'Spotify กำลังจำกัดการเรียกข้อมูล กรุณาลองใหม่ภายหลัง'
                            : status === 404
                                ? 'Spotify ไม่พบเพลย์ลิสต์สำหรับบัญชีนี้'
                                : 'เชื่อมต่อ Spotify เพื่อโหลดเพลย์ลิสต์ไม่สำเร็จ';
                    playlistsBox.appendChild(replayCreateText('div', 'home-collection-loading', message));
                    return;
                }
            }

            if (playlists.length) {
                const selection = playlists.slice(0, 10);
                if (selection.length) {
                    selection.forEach(playlist => {
                        const card = document.createElement('button');
                        card.type = 'button';
                        card.className = 'home-personalized-card';
                        const image = document.createElement('img');
                        image.src = playlist.images?.[0]?.url || '';
                        image.alt = '';
                        image.loading = 'lazy';
                        const name = replayCreateText('strong', '', playlist.name);
                        const owner = replayCreateText('span', '', playlist.owner?.display_name || `${playlist.tracks?.total || 0} เพลง`);
                        card.append(image, name, owner);
                        card.addEventListener('click', () => playTrack(undefined, playlist.uri));
                        playlistsBox.appendChild(card);
                    });
                } else {
                    playlistsBox.appendChild(replayCreateText('div', 'home-collection-loading', 'ยังไม่มีเพลย์ลิสต์ใน Spotify'));
                }
            } else {
                const message = playlistSource === 'library'
                    ? 'ยังไม่มีเพลย์ลิสต์ในคลัง Spotify ของคุณ'
                    : 'Spotify ยังไม่มีเพลย์ลิสต์แนะนำในขณะนี้';
                playlistsBox.appendChild(replayCreateText('div', 'home-collection-loading', message));
            }

            if (developerSoundsBox) {
                developerSoundsBox.replaceChildren();
                if (developerSoundsResult.status === 'fulfilled' && developerSoundsResult.value?.ok) {
                    const items = developerSoundsResult.value.items || [];
                    developerSoundsCache = items;
                    if (items.length) {
                        items.forEach(sound => {
                            const card = document.createElement('button');
                            card.type = 'button';
                            card.className = 'home-personalized-card developer-sound-card';
                            let cover;
                            if (sound.cover) {
                                cover = document.createElement('img');
                                cover.src = sound.cover;
                                cover.alt = '';
                                cover.loading = 'lazy';
                                cover.referrerPolicy = 'no-referrer';
                            } else {
                                cover = replayCreateText('div', 'developer-sound-cover-placeholder', '♫');
                            }
                            card.append(
                                cover,
                                replayCreateText('strong', '', sound.title),
                                replayCreateText('span', '', Array.isArray(sound.tracks) ? `${sound.tracks.length} เพลง` : sound.spotifyUri.startsWith('spotify:album:') ? 'อัลบั้ม' : 'เพลย์ลิสต์')
                            );
                            card.addEventListener('click', () => handleDeveloperSoundClick(sound));
                            developerSoundsBox.appendChild(card);
                        });
                    } else {
                        developerSoundsBox.appendChild(replayCreateText('div', 'home-collection-loading', 'ผู้พัฒนายังไม่ได้เพิ่มรายการ'));
                    }
                } else {
                    console.error('Developer sounds error:', developerSoundsResult.status === 'rejected' ? developerSoundsResult.reason : developerSoundsResult.value?.error);
                    developerSoundsBox.appendChild(replayCreateText('div', 'home-collection-loading', 'โหลดรายการที่ผู้พัฒนาคัดสรรไม่สำเร็จ'));
                }
            }
        }

        async function loadAllTopArtists() {
            const box = document.getElementById('all-top-artists');
            if (!box) return;
            box.replaceChildren(replayCreateText('div', 'home-collection-loading', 'กำลังโหลดศิลปิน...'));
            try {
                const result = await getUserTopArtists();
                box.replaceChildren();
                const artists = result?.items || [];
                if (!artists.length) {
                    box.appendChild(replayCreateText('div', 'home-collection-loading', 'ยังไม่มีข้อมูลศิลปินยอดนิยม'));
                    return;
                }
                artists.forEach(artist => {
                    const card = document.createElement('button');
                    card.type = 'button';
                    card.className = 'home-artist-card';
                    const image = document.createElement('img');
                    const imageUrl = artist.images?.[0]?.url;
                    if (imageUrl) image.src = imageUrl;
                    image.alt = '';
                    image.loading = 'lazy';
                    card.append(image, replayCreateText('strong', '', artist.name), replayCreateText('span', '', 'ศิลปิน'));
                    card.addEventListener('click', () => handleArtistClick(artist.id));
                    box.appendChild(card);
                });
            } catch (error) {
                console.error('All top artists error:', error);
                box.replaceChildren(replayCreateText('div', 'home-collection-loading', 'โหลดรายชื่อศิลปินไม่สำเร็จ'));
                showToast('โหลดรายชื่อศิลปินจาก Spotify ไม่สำเร็จ', 'error');
            }
        }

        let replayHistoryItems = [];
        let replaySelectedMonth = '';
        let replayRenderId = 0;
        let replayShareData = null;
        const replayAccumulatedStats = new Map();
        const replayBackupPendingMonths = new Set();

        function replayMonthKey(playedAt) {
            const date = new Date(playedAt);
            if (Number.isNaN(date.getTime())) return '';
            return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        }

        function replayMonthLabel(monthKey) {
            const [year, month] = monthKey.split('-').map(Number);
            return new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
        }

        function replayAggregate(items) {
            const artists = new Map();
            const tracks = new Map();
            const albums = new Map();

            for (const item of items) {
                const track = item.track;
                if (!track) continue;
                const durationMs = Math.max(0, Number(track.duration_ms) || 0);
                const trackKey = track.id || track.uri || track.name;
                const trackEntry = tracks.get(trackKey) || { name: track.name, artists: track.artists || [], image: track.album?.images?.[0]?.url || '', durationMs, count: 0, uri: track.uri };
                trackEntry.count++;
                tracks.set(trackKey, trackEntry);

                for (const artist of track.artists || []) {
                    if (!artist?.name) continue;
                    const artistKey = artist.id || artist.name;
                    const artistEntry = artists.get(artistKey) || { id: artist.id || '', name: artist.name, image: '', fallbackImage: track.album?.images?.[0]?.url || '', count: 0, estimatedMs: 0 };
                    artistEntry.count++;
                    artistEntry.estimatedMs += durationMs;
                    artists.set(artistKey, artistEntry);
                }

                const album = track.album;
                if (album?.name) {
                    const albumKey = album.id || album.name;
                    const albumEntry = albums.get(albumKey) || { name: album.name, artists: track.artists || [], image: album.images?.[0]?.url || '', count: 0 };
                    albumEntry.count++;
                    albums.set(albumKey, albumEntry);
                }
            }

            const mostPlayed = map => [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'th'));
            const estimatedMs = [...tracks.values()].reduce((total, track) => total + track.count * track.durationMs, 0);
            return {
                artists: [...artists.values()].map(artist => ({ ...artist, estimatedMinutes: Math.round(artist.estimatedMs / 60000) }))
                    .sort((a, b) => b.estimatedMs - a.estimatedMs || a.name.localeCompare(b.name, 'th')),
                tracks: mostPlayed(tracks),
                albums: mostPlayed(albums),
                estimatedMinutes: Math.round(estimatedMs / 60000),
                playCount: [...tracks.values()].reduce((total, track) => total + track.count, 0)
            };
        }

        function replayCreateText(tag, className, text) {
            const element = document.createElement(tag);
            if (className) element.className = className;
            element.textContent = text;
            return element;
        }

        function replayCreateRankCard(item, index) {
            const card = document.createElement('article');
            card.className = 'replay-rank-card';
            const image = document.createElement('div');
            image.className = `replay-rank-image${index === 0 ? ' is-featured' : ''}`;
            const imageUrl = item.image || item.fallbackImage;
            if (imageUrl) image.style.backgroundImage = `linear-gradient(180deg, transparent 25%, rgba(0,0,0,.75)), url("${imageUrl}")`;
            const rank = replayCreateText('span', 'replay-rank-number', String(index + 1));
            const name = replayCreateText('strong', 'replay-rank-name', item.name);
            const metric = replayCreateText('span', 'replay-rank-plays', `${(item.estimatedMinutes || 0).toLocaleString('th-TH')} นาทีโดยประมาณ`);
            image.append(rank, name, metric);
            card.appendChild(image);
            return card;
        }

        function replayCreateList(items, kind) {
            const list = document.createElement('ol');
            list.className = 'replay-list';
            items.slice(0, 10).forEach((item, index) => {
                const row = document.createElement('li');
                row.className = 'replay-list-row';
                const rank = replayCreateText('span', 'replay-list-index', String(index + 1).padStart(2, '0'));
                const image = document.createElement('img');
                image.className = 'replay-list-art';
                image.alt = '';
                const imageUrl = item.image || item.fallbackImage;
                if (imageUrl) image.src = imageUrl;
                image.loading = 'lazy';
                const details = document.createElement('span');
                details.className = 'replay-list-details';
                details.append(
                    replayCreateText('strong', 'replay-list-title', item.name),
                    replayCreateText('span', 'replay-list-subtitle', (item.artists || []).map(artist => artist.name).join(', '))
                );
                row.append(rank, image, details, replayCreateText('span', 'replay-list-count', `${item.count}×`));
                if (kind === 'track' && item.uri) {
                    row.tabIndex = 0;
                    row.setAttribute('role', 'button');
                    row.setAttribute('aria-label', `เล่น ${item.name}`);
                    const playFromRow = () => playTrack(item.uri);
                    row.addEventListener('click', playFromRow);
                    row.addEventListener('keydown', event => {
                        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); playFromRow(); }
                    });
                }
                list.appendChild(row);
            });
            return list;
        }

        async function replayLoadArtistImages(items, renderId) {
            const ids = [...new Set(items.map(item => item.id).filter(Boolean))].slice(0, 50);
            if (!ids.length) return;
            try {
                const result = await fetchWebApi(`v1/artists?ids=${ids.join(',')}`);
                if (renderId !== replayRenderId) return;
                const imageById = new Map((result?.artists || []).map(artist => [artist.id, artist.images?.[0]?.url || '']));
                items.forEach((item, index) => {
                    item.image = imageById.get(item.id) || '';
                    const cardImage = document.querySelector(`#replay-artists .replay-rank-card:nth-child(${index + 1}) .replay-rank-image`);
                    if (cardImage && item.image) cardImage.style.backgroundImage = `linear-gradient(180deg, transparent 25%, rgba(0,0,0,.75)), url("${item.image}")`;
                });
                if (replayShareData) replayShareData.stats.artists = items;
            } catch (error) {
                console.error('Replay artist images error:', error);
            }
        }

        function renderReplay() {
            const select = document.getElementById('replay-month');
            const content = document.getElementById('replay-content');
            const note = document.getElementById('replay-data-note');
            const shareButton = document.getElementById('btn-replay-share');
            if (!select || !content) return;

            const monthKeys = [...new Set(replayHistoryItems.map(item => replayMonthKey(item.played_at)).filter(Boolean))].sort().reverse();
            if (!monthKeys.length) {
                select.replaceChildren(new Option('ไม่มีข้อมูล', ''));
                select.disabled = true;
                shareButton.disabled = true;
                replayShareData = null;
                content.replaceChildren(replayCreateText('div', 'replay-empty', 'ยังไม่มีประวัติการฟังที่ Spotify ส่งกลับมา'));
                note.textContent = 'Spotify API ไม่มีข้อมูลย้อนหลังให้แสดงในขณะนี้';
                return;
            }

            select.disabled = false;
            select.replaceChildren(...monthKeys.map(key => new Option(replayMonthLabel(key), key)));
            if (!monthKeys.includes(replaySelectedMonth)) replaySelectedMonth = monthKeys[0];
            select.value = replaySelectedMonth;

            const monthItems = replayHistoryItems.filter(item => replayMonthKey(item.played_at) === replaySelectedMonth && item.track);
            const accumulatedStats = replayAccumulatedStats.get(replaySelectedMonth);
            const stats = accumulatedStats || replayAggregate(monthItems);
            const renderId = ++replayRenderId;
            shareButton.disabled = stats.playCount === 0;
            const dataNote = replayCreateText('p', 'replay-data-note', `สะสม ${stats.playCount.toLocaleString('th-TH')} ครั้งที่ตรวจพบ · เวลาคำนวณจากความยาวเพลง`);
            note.replaceWith(dataNote);
            dataNote.id = 'replay-data-note';
            replayShareData = { monthKey: replaySelectedMonth, stats };
            content.replaceChildren();
            if (!accumulatedStats && !replayBackupPendingMonths.has(replaySelectedMonth)) {
                replayBackupPendingMonths.add(replaySelectedMonth);
                backupReplayStats(replaySelectedMonth, monthItems).then(cumulativeStats => {
                    replayAccumulatedStats.set(replaySelectedMonth, cumulativeStats);
                    if (replaySelectedMonth === select.value) renderReplay();
                }).catch(error => {
                    console.error('Replay accumulation error:', error);
                }).finally(() => replayBackupPendingMonths.delete(replaySelectedMonth));
            }

            const summary = document.createElement('section');
            summary.className = 'replay-summary';
            summary.append(
                replayCreateText('span', 'replay-summary-label', 'เวลาฟังโดยประมาณ'),
                replayCreateText('h2', 'replay-summary-value', stats.estimatedMinutes.toLocaleString('th-TH')),
                replayCreateText('span', 'replay-summary-unit', `นาที · ${replayMonthLabel(replaySelectedMonth)}`)
            );
            const summaryGlow = document.createElement('span');
            summaryGlow.className = 'replay-summary-glow';
            summary.prepend(summaryGlow);
            content.appendChild(summary);

            const artistsSection = document.createElement('section');
            artistsSection.className = 'replay-section';
            const artistHeading = document.createElement('div');
            artistHeading.className = 'replay-section-heading';
            artistHeading.append(replayCreateText('h2', '', 'ศิลปินยอดนิยม'), replayCreateText('span', '', 'นาทีโดยประมาณ · จากรายการที่ได้รับ'));
            const artistGrid = document.createElement('div');
            artistGrid.className = 'replay-rank-grid';
            artistGrid.id = 'replay-artists';
            if (!stats.artists.length) artistGrid.appendChild(replayCreateText('p', 'replay-no-items', 'ไม่มีข้อมูลศิลปินในเดือนนี้'));
            else stats.artists.slice(0, 5).forEach((artist, index) => artistGrid.appendChild(replayCreateRankCard(artist, index)));
            artistsSection.append(artistHeading, artistGrid);
            content.appendChild(artistsSection);

            const lists = document.createElement('div');
            lists.className = 'replay-lists-grid';
            [
                { title: 'เพลงยอดนิยม', items: stats.tracks, kind: 'track' },
                { title: 'อัลบั้มยอดนิยม', items: stats.albums, kind: 'album' }
            ].forEach(section => {
                const panel = document.createElement('section');
                panel.className = 'replay-list-panel';
                panel.append(replayCreateText('h2', 'replay-section-title', section.title));
                if (section.items.length) panel.appendChild(replayCreateList(section.items, section.kind));
                else panel.appendChild(replayCreateText('p', 'replay-no-items', 'ไม่มีข้อมูลในเดือนนี้'));
                lists.appendChild(panel);
            });
            content.appendChild(lists);
            replayLoadArtistImages(stats.artists.slice(0, 5), renderId);
        }

        async function backupReplayStats(monthKey, monthItems) {
            const status = document.getElementById('replay-backup-status');
            if (!status) return;
            status.textContent = 'กำลังสำรองสถิติลง Google Sheets...';
            status.className = 'replay-backup-status is-pending';
            try {
                const result = await rankingApi({
                    action: 'replay_backup',
                    token: localStorage.getItem('spotify_access_token'),
                    month: monthKey,
                    plays: monthItems.filter(item => item.track?.id && item.played_at).map(item => ({
                        trackId: item.track.id,
                        name: item.track.name,
                        artists: (item.track.artists || []).map(({ id, name }) => ({ id, name })),
                        album: {
                            id: item.track.album?.id || '',
                            name: item.track.album?.name || '',
                            image: item.track.album?.images?.[0]?.url || ''
                        },
                        durationMs: Number(item.track.duration_ms) || 0,
                        playedAt: item.played_at
                    }))
                });
                if (!result?.ok) throw new Error(result?.error || 'backup_failed');
                status.textContent = '';
                status.className = 'replay-backup-status is-success';
                return result.stats;
            } catch (error) {
                console.error('Replay backup error:', error);
                status.textContent = `สำรองสถิติไม่สำเร็จ (${error.message || 'ไม่ทราบสาเหตุ'})`;
                status.className = 'replay-backup-status is-error';
                throw error;
            }
        }

        async function loadReplayHistory() {
            const content = document.getElementById('replay-content');
            content.replaceChildren(replayCreateText('div', 'replay-loading', 'กำลังโหลดสถิติจาก Spotify...'));
            try {
                const history = await getRecentlyPlayed();
                replayHistoryItems = history?.items || [];
                renderReplay();
            } catch (error) {
                console.error('Replay history error:', error);
                document.getElementById('btn-replay-share').disabled = true;
                content.replaceChildren(replayCreateText('div', 'replay-empty', 'โหลดสถิติไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'));
                showToast('โหลดสถิติการฟังจาก Spotify ไม่สำเร็จ', 'error');
            }
        }

        async function replayCreateShareImage() {
            if (!replayShareData) throw new Error('ไม่มีข้อมูลสำหรับสร้างภาพ');
            const { monthKey } = replayShareData;
            const canvas = document.createElement('canvas');
            canvas.width = 900;
            canvas.height = 1200;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('เบราว์เซอร์ไม่รองรับการสร้างภาพ');
            await document.fonts?.ready;
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const card = { x: 24, y: 24, width: 852, height: 1152, radius: 54 };
            ctx.beginPath();
            ctx.moveTo(card.x + card.radius, card.y);
            ctx.arcTo(card.x + card.width, card.y, card.x + card.width, card.y + card.height, card.radius);
            ctx.arcTo(card.x + card.width, card.y + card.height, card.x, card.y + card.height, card.radius);
            ctx.arcTo(card.x, card.y + card.height, card.x, card.y, card.radius);
            ctx.arcTo(card.x, card.y, card.x + card.width, card.y, card.radius);
            ctx.closePath();
            ctx.save();
            ctx.clip();
            const background = ctx.createLinearGradient(card.x, card.y, card.x + card.width, card.y + card.height);
            background.addColorStop(0, '#ffc72e');
            background.addColorStop(.3, '#f8b64b');
            background.addColorStop(.54, '#48dbc0');
            background.addColorStop(.78, '#f59a42');
            background.addColorStop(1, '#ffc52c');
            ctx.fillStyle = background;
            ctx.fillRect(card.x, card.y, card.width, card.height);
            ctx.restore();
            ctx.strokeStyle = 'rgba(255,255,255,.3)';
            ctx.lineWidth = 3;
            ctx.stroke();

            const pad = 68;
            const year = monthKey.slice(0, 4);
            const month = new Intl.DateTimeFormat('th-TH', { month: 'long' })
                .format(new Date(Number(year), Number(monthKey.slice(5, 7)) - 1, 1));
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = '#fff';
            ctx.shadowColor = 'rgba(95,55,25,.15)';
            ctx.shadowBlur = 12;
            ctx.font = '700 88px Outfit, Kanit, sans-serif';
            ctx.fillText('Replay', card.x + pad, card.y + 350);
            ctx.fillStyle = 'rgba(255,255,255,.82)';
            ctx.font = '600 76px Kanit, sans-serif';
            ctx.fillText('ซาวด์โดนใจ', card.x + pad, card.y + 465);
            ctx.fillText('ในเดือน', card.x + pad, card.y + 560);
            ctx.fillStyle = '#fff0a8';
            ctx.font = '700 76px Kanit, sans-serif';
            ctx.fillText(month, card.x + pad, card.y + 675);
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#fff';
            ctx.font = '600 48px Outfit, Kanit, sans-serif';
            ctx.fillText(`Replay ${year}`, card.x + pad + 8, card.y + 920);
            ctx.font = '400 36px Kanit, sans-serif';
            ctx.fillText(`ฟังซาวด์ปี ${year} ของคุณและกลับสู่จุดเริ่ม`, card.x + pad + 8, card.y + 980);
            ctx.fillText('ต้นด้วย Replay ทุกช่วงเวลา', card.x + pad + 8, card.y + 1030);

            return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('สร้างไฟล์ภาพไม่สำเร็จ')), 'image/png'));
        }

        async function shareReplayImage() {
            const button = document.getElementById('btn-replay-share');
            button.disabled = true;
            const originalText = button.textContent;
            button.textContent = 'กำลังเตรียมภาพ...';
            try {
                const blob = await replayCreateShareImage();
                const file = new File([blob], 'r-music-replay.png', { type: 'image/png' });
                const monthLabel = replayMonthLabel(replayShareData.monthKey);
                const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
                    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
                if (isMobileDevice && navigator.canShare?.({ files: [file] }) && navigator.share) {
                    await navigator.share({ title: `Replay ซาวด์โดนใจในเดือน ${monthLabel}`, text: `Replay ซาวด์โดนใจในเดือน ${monthLabel}`, files: [file] });
                } else {
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = 'r-music-replay.png';
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    showToast('ดาวน์โหลดภาพ Replay แล้ว แชร์ภาพจากแกลเลอรีได้เลย', 'info');
                }
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error('Replay share error:', error);
                    showToast('สร้างหรือแชร์ภาพ Replay ไม่สำเร็จ', 'error');
                }
            } finally {
                button.disabled = false;
                button.textContent = originalText;
            }
        }
        function renderSearchResults(results, onPlay, onArtistClick, onAlbumClick) {
            const container = document.getElementById('search-results'), artistsContainer = document.getElementById('search-artists'), albumsContainer = document.getElementById('search-albums');
            container.innerHTML = ''; artistsContainer.innerHTML = ''; if (albumsContainer) albumsContainer.innerHTML = '';
            if (!results) return;
            results.artists?.items?.slice(0, 5).forEach(artist => {
                const div = document.createElement('div'); div.className = 'artist-card playlist-card';
                const imgUrl = artist.images?.[0]?.url || '';
                div.innerHTML = `<img src="${imgUrl}" alt="${artist.name}" style="border-radius:50%"><div class="playlist-title" style="text-align:center;margin-top:10px">${artist.name}</div>`;
                div.onclick = () => onArtistClick(artist.id); artistsContainer.appendChild(div);
            });
            results.albums?.items?.slice(0, 5).forEach(album => {
                const div = document.createElement('div'); div.className = 'album-card playlist-card';
                const imgUrl = album.images?.[0]?.url || '';
                div.innerHTML = `<img src="${imgUrl}" alt="${album.name}"><div class="playlist-title">${album.name}</div><div class="playlist-owner">${album.artists?.map(a => a.name).join(', ') || ''}</div>`;
                div.onclick = () => onAlbumClick(album.id); albumsContainer?.appendChild(div);
            });
            results.tracks?.items?.forEach(track => {
                const div = document.createElement('div'); div.className = 'track-item';
                div.innerHTML = `<img src="${track.album.images[0]?.url}" alt="${track.name}"><div class="track-item-info"><div class="track-item-title">${track.name}</div><div class="track-item-artist">${rememberExplicit(track)}${track.artists.map(a => a.name).join(', ')}</div></div>`;
                div.appendChild(trackRowActions(track));
                div.onclick = () => onPlay(track.uri);
                div.oncontextmenu = (e) => { e.preventDefault(); if (window.showTrackContextMenu) window.showTrackContextMenu(e, track); };
                container.appendChild(div);
            });
            if (!(results.artists?.items?.length || results.albums?.items?.length || results.tracks?.items?.length)) {
                const status = document.getElementById('search-api-status');
                if (status) status.textContent = 'ไม่พบผลการค้นหา ลองใช้คำค้นอื่น';
            }
        }
        // ปุ่มถูกใจ + เพิ่มเข้าเพลย์ลิสต์ ต่อท้ายแต่ละแถวเพลง (หน้าค้นหา/ศิลปิน/อัลบั้ม)
        function trackRowActions(track) {
            const wrap = document.createElement('div'); wrap.className = 'track-item-actions';
            const queue = document.createElement('button'); queue.type = 'button'; queue.className = 'row-icon-btn row-queue-btn'; queue.title = 'เพิ่มเข้าคิวเล่นถัดไป';
            queue.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M15,6H3V8H15V6M15,10H3V12H15V10M3,16H11V14H3V16Z"/></svg>';
            queue.onclick = e => { e.stopPropagation(); addToQueue(track); };
            wrap.appendChild(queue);
            return wrap;
        }

        // เพิ่มเพลงเข้าคิวเล่นถัดไป (Spotify Connect) ต้องมีอุปกรณ์กำลังเล่นเพลงอยู่ก่อน
        async function addToQueue(track) {
            const uri = track.uri || `spotify:track:${track.id}`;
            try {
                await fetchWebApi(`v1/me/player/queue?uri=${encodeURIComponent(uri)}&device_id=${remote.id || deviceId}`, 'POST');
                showToast('➕ เพิ่มเข้าคิวเล่นถัดไปแล้ว', 'info');
            } catch (e) {
                console.error('Add to queue error:', e);
                showToast(e.status === 404 ? '❌ ต้องเล่นเพลงอยู่ก่อนถึงจะเพิ่มเข้าคิวได้' : '❌ เพิ่มเข้าคิวไม่สำเร็จ', 'error');
            }
        }

        // ---------- เพลย์ลิสต์แนะนำประจำวัน (จันทร์-ศุกร์) ----------
        // ใช้เพลย์ลิสต์ทางการของ Spotify (ID สาธารณะ คงที่ ไม่ผูกกับบัญชีผู้ใช้) สลับตามวัน
        // ยืนยันแล้วว่าใช้ได้จริง 2 รายการ (ชาร์ตไทย) หากต้องการเพิ่มวันละเพลย์ลิสต์ต่างกันจริงๆ
        // ให้หา Playlist ID จาก Spotify (คลิกขวาเพลย์ลิสต์ > Share > Copy link) แล้วใส่เพิ่มในนี้
        const DAILY_CHART_PLAYLISTS = {
            1: { id: '37i9dQZEVXbMnz8KIWsvf9', label: 'จันทร์' }, // Top 50 - Thailand
            2: { id: '37i9dQZEVXbL0GavIqMTeb', label: 'อังคาร' }, // Viral 50 - Thailand
            3: { id: '37i9dQZEVXbMnz8KIWsvf9', label: 'พุธ' },
            4: { id: '37i9dQZEVXbL0GavIqMTeb', label: 'พฤหัสบดี' },
            5: { id: '37i9dQZEVXbMnz8KIWsvf9', label: 'ศุกร์' },
            0: { id: '37i9dQZEVXbMnz8KIWsvf9', label: 'อาทิตย์' }, // เสาร์-อาทิตย์ ใช้ของจันทร์แทน กันหน้าว่าง
            6: { id: '37i9dQZEVXbL0GavIqMTeb', label: 'เสาร์' }
        };

        async function loadDailyChart() {
            const box = document.getElementById('daily-charts'); if (!box) return;
            const conf = DAILY_CHART_PLAYLISTS[new Date().getDay()];
            try {
                const fields = 'name,uri,external_urls,tracks.items(track(id,name,uri,duration_ms,explicit,artists(name),album(images)))';
                const pl = await fetchWebApi(`v1/playlists/${conf.id}?market=TH&fields=${encodeURIComponent(fields)}`);
                const tracks = (pl?.tracks?.items || []).map(it => it.track).filter(Boolean).slice(0, 10);
                if (!tracks.length) { box.innerHTML = ''; return; }
                box.innerHTML = '';

                const heading = document.createElement('div');
                heading.className = 'daily-chart-heading';
                heading.innerHTML = `
      <div class="daily-chart-title">เพลย์ลิสต์ที่คุณอาจถูกใจประจำวัน${conf.label}</div>
      <div class="daily-chart-source">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M12,6A6,6 0 0,0 6,12A6,6 0 0,0 12,18A6,6 0 0,0 18,12A6,6 0 0,0 12,6M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8Z"/></svg>
        <span>อ้างอิงจาก <a href="${pl.external_urls?.spotify || '#'}" target="_blank">เพลย์ลิสต์ทางการ Spotify</a></span>
      </div>
    `;
                box.appendChild(heading);

                const list = rkEl('div', 'tracks-list daily-chart-list');
                tracks.forEach((t, i) => {
                    const div = document.createElement('div'); div.className = 'track-item';
                    div.innerHTML = `<div class="chart-rank">${i + 1}</div><img src="${t.album?.images?.[0]?.url || ''}" alt="${t.name}"><div class="track-item-info"><div class="track-item-title">${t.name}</div><div class="track-item-artist">${t.explicit ? '<span class="rank-explicit" title="เนื้อหาไม่เหมาะสม (Explicit)">E</span>' : ''}${t.artists.map(a => a.name).join(', ')}</div></div>`;
                    div.appendChild(trackRowActions(t));
                    div.onclick = () => playTrack(t.uri, pl.uri);
                    list.appendChild(div);
                });
                box.appendChild(list);
            } catch (e) { console.error('Daily chart error:', e); box.innerHTML = ''; } // โหลดไม่สำเร็จ (เช่นเพลย์ลิสต์ถูกลบ/ย้าย) ให้ข้ามไปเงียบๆ ไม่ทำให้หน้าแรกพัง
        }
        function renderArtistView(artist, topTracks, albums, onPlay, onAlbumClick, isFollowing, onToggleFollow) {
            const header = document.getElementById('artist-header');
            const imgUrl = artist.images?.[0]?.url || '';
            const genresText = (artist.genres || []).slice(0, 3).join(' • ');
            header.innerHTML = `<div class="artist-hero"><div class="artist-hero-shade"></div><div class="artist-page-actions"><button type="button" class="artist-page-icon" id="btn-artist-back" aria-label="ย้อนกลับ" title="ย้อนกลับ"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg></button><div class="artist-page-actions-right"><button type="button" class="artist-page-icon" id="btn-artist-share" aria-label="แชร์ศิลปิน" title="แชร์"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7a3.3 3.3 0 0 0 0-1.39l7.05-4.11A3 3 0 1 0 15 5c0 .24.03.47.08.7L8.03 9.81a3 3 0 1 0 0 4.38l7.12 4.16c-.05.2-.07.42-.07.65a2.92 2.92 0 1 0 2.92-2.92z"/></svg></button><button type="button" class="artist-page-icon" id="btn-artist-open" aria-label="เปิดศิลปินใน Spotify" title="เปิดใน Spotify"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 8a1.75 1.75 0 1 0 0 3.5A1.75 1.75 0 0 0 12 8zm0 4.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zm0 4.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5z"/></svg></button></div></div>${imgUrl ? '<img class="artist-hero-image" alt="">' : ''}<div class="artist-hero-content"><h1></h1><p class="artist-genres hidden"></p><div class="artist-hero-actions"><button type="button" class="artist-round-btn" id="btn-artist-info" aria-label="ข้อมูลศิลปินจาก MusicBrainz" title="ข้อมูลศิลปินจาก MusicBrainz">i</button><button type="button" class="artist-round-btn artist-play-btn" id="btn-play-artist" aria-label="เล่นเพลงยอดนิยม" title="เล่นเพลงยอดนิยม"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5.14v13.72L19 12 8 5.14z"/></svg></button><button type="button" class="artist-round-btn artist-follow-btn${isFollowing ? ' is-following' : ''}" id="btn-follow-artist" aria-label="${isFollowing ? 'เลิกติดตามศิลปิน' : 'ติดตามศิลปิน'}" title="${isFollowing ? 'กำลังติดตาม' : 'ติดตามศิลปิน'}"><svg viewBox="0 0 24 24"><path d="M12 2.5 14.94 8.46l6.57.95-4.75 4.63 1.12 6.54L12 17.49l-5.88 3.09 1.12-6.54-4.75-4.63 6.57-.95L12 2.5z"/></svg></button></div></div></div>`;
            header.querySelector('.artist-hero-content h1').textContent = artist.name;
            header.querySelector('.artist-genres').textContent = genresText;
            const heroImage = header.querySelector('.artist-hero-image');
            if (heroImage) heroImage.src = imgUrl;
            document.getElementById('btn-artist-back').onclick = () => history.back();
            document.getElementById('btn-artist-open').onclick = () => {
                const spotifyUrl = artist.external_urls?.spotify;
                if (spotifyUrl) window.open(spotifyUrl, '_blank', 'noopener');
                else showToast('ไม่พบลิงก์ Spotify ของศิลปินนี้', 'warning');
            };
            document.getElementById('btn-artist-share').onclick = async () => {
                const url = artist.external_urls?.spotify || window.location.href;
                try {
                    if (navigator.share) await navigator.share({ title: artist.name, url });
                    else { await navigator.clipboard.writeText(url); showToast('คัดลอกลิงก์ศิลปินแล้ว', 'info'); }
                } catch (e) {
                    if (e.name !== 'AbortError') {
                        console.error('Share artist error:', e);
                        showToast('❌ แชร์ศิลปินไม่สำเร็จ', 'error');
                    }
                }
            };
            const followBtn = document.getElementById('btn-follow-artist');
            if (followBtn && onToggleFollow) followBtn.onclick = onToggleFollow;
            const infoBtn = document.getElementById('btn-artist-info');
            infoBtn.disabled = false;
            infoBtn.setAttribute('aria-label', 'ข้อมูลศิลปินจาก Wikipedia');
            infoBtn.title = 'ข้อมูลศิลปินจาก Wikipedia';
            infoBtn.onclick = () => loadWikipediaArtistInfo(artist);
            const playArtistBtn = document.getElementById('btn-play-artist');
            playArtistBtn.disabled = !topTracks?.tracks?.length;
            playArtistBtn.onclick = () => { if (topTracks?.tracks?.[0]) onPlay(topTracks.tracks[0].uri); };
            const tracksContainer = document.getElementById('artist-top-tracks'); tracksContainer.innerHTML = '';
            topTracks?.tracks?.slice(0, 5).forEach(track => {
                const div = document.createElement('div'); div.className = 'track-item';
                div.innerHTML = `<img src="${track.album?.images?.[0]?.url || ''}" alt="${track.name}"><div class="track-item-info"><div class="track-item-title">${track.name}</div><div class="track-item-artist">${rememberExplicit(track)}${track.artists?.map(a => a.name).join(', ')}</div></div>`;
                div.appendChild(trackRowActions(track));
                div.onclick = () => onPlay(track.uri);
                div.oncontextmenu = (e) => { e.preventDefault(); if (window.showTrackContextMenu) window.showTrackContextMenu(e, track); };
                tracksContainer.appendChild(div);
            });
            const albumItems = [...(albums?.items || [])].sort((a, b) => (b.release_date || '').localeCompare(a.release_date || ''));
            const albumsContainer = document.getElementById('artist-albums');
            albumsContainer.replaceChildren();
            document.getElementById('artist-albums-section').classList.toggle('hidden', !albumItems.length);
            albumItems.forEach(album => {
                const card = document.createElement('div');
                card.className = 'artist-album-card playlist-card';
                card.innerHTML = `<img src="${album.images?.[0]?.url || ''}" alt="${album.name}"><div class="playlist-title">${album.name}</div><div class="playlist-owner">${album.release_date?.slice(0, 4) || ''}</div>`;
                card.onclick = () => onAlbumClick(album.id);
                albumsContainer.appendChild(card);
            });
            const featuredSection = document.getElementById('artist-featured-section');
            const featuredContainer = document.getElementById('artist-featured-release');
            featuredContainer.replaceChildren();
            const featuredAlbum = albumItems[0];
            featuredSection.classList.toggle('hidden', !featuredAlbum);
            if (featuredAlbum) {
                const releaseDate = /^\d{4}-\d{2}-\d{2}$/.test(featuredAlbum.release_date || '')
                    ? new Date(`${featuredAlbum.release_date}T00:00:00`).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })
                    : featuredAlbum.release_date || '';
                const release = document.createElement('button');
                release.type = 'button';
                release.className = 'artist-release-card';
                release.setAttribute('aria-label', `เปิดอัลบั้ม ${featuredAlbum.name}`);
                release.innerHTML = `<img src="${featuredAlbum.images?.[0]?.url || ''}" alt=""><span class="artist-release-copy"><span class="artist-release-date">${releaseDate}</span><strong>${featuredAlbum.name}</strong><span>${featuredAlbum.total_tracks || 0} เพลง</span></span><span class="artist-release-open" aria-hidden="true">+</span>`;
                release.onclick = () => onAlbumClick(featuredAlbum.id);
                featuredContainer.appendChild(release);
            }
        }
        function renderAlbumView(album, tracksData) {
            const header = document.getElementById('album-header');
            const imgUrl = album.images?.[0]?.url || '';
            const year = album.release_date ? new Date(album.release_date).getFullYear() : '';
            const artistNames = album.artists?.map(a => a.name).join(', ') || '';
            const totalTracks = album.total_tracks || tracksData?.items?.length || 0;
            header.innerHTML = `<div style="display:flex;align-items:center;gap:20px;margin-bottom:30px"><img src="${imgUrl}" alt="${album.name}" style="width:150px;height:150px;border-radius:12px;object-fit:cover;box-shadow:0 8px 24px rgba(0,0,0,.5)"><div><h1 style="font-size:2.5rem;margin:0">${album.name}</h1><p style="color:var(--text-muted);margin-top:10px">${artistNames}${year ? ' • ' + year : ''} • ${totalTracks} เพลง</p></div></div>`;
            const tracks = tracksData?.items || [];
            const actions = document.createElement('div');
            actions.className = 'album-hero-actions';
            const playAlbum = document.createElement('button');
            playAlbum.type = 'button';
            playAlbum.className = 'artist-round-btn artist-play-btn';
            playAlbum.setAttribute('aria-label', 'เล่นอัลบั้ม');
            playAlbum.title = 'เล่นอัลบั้ม';
            playAlbum.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5.14v13.72L19 12 8 5.14z"/></svg>';
            playAlbum.addEventListener('click', () => playTrackSequence(tracks));
            const shuffleAlbum = document.createElement('button');
            shuffleAlbum.type = 'button';
            shuffleAlbum.className = 'artist-round-btn album-shuffle-btn';
            shuffleAlbum.setAttribute('aria-label', 'สุ่มเพลงในอัลบั้ม');
            shuffleAlbum.title = 'สุ่มเพลงในอัลบั้ม';
            shuffleAlbum.textContent = '🔀';
            shuffleAlbum.addEventListener('click', () => playTrackSequence(tracks, undefined, true));
            actions.append(playAlbum, shuffleAlbum);
            header.firstElementChild?.lastElementChild?.appendChild(actions);

            const tracksContainer = document.getElementById('album-tracks'); tracksContainer.innerHTML = '';
            tracks.forEach((track, idx) => {
                const div = document.createElement('div'); div.className = 'track-item';
                const trackWithAlbum = { ...track, album };
                div.innerHTML = `<img src="${imgUrl}" alt="${track.name}"><div class="track-item-info"><div class="track-item-title">${idx + 1}. ${track.name}</div><div class="track-item-artist">${rememberExplicit(track)}${track.artists?.map(a => a.name).join(', ')}</div></div>`;
                div.appendChild(trackRowActions(trackWithAlbum));
                div.onclick = () => playTrackSequence(tracks, track.uri);
                div.oncontextmenu = (e) => { e.preventDefault(); if (window.showTrackContextMenu) window.showTrackContextMenu(e, trackWithAlbum); };
                tracksContainer.appendChild(div);
            });
        }
        // Spotify ยิง player_state_changed บ่อยกว่าแค่ตอนเปลี่ยนเพลง (เช่น ทุกครั้งที่ seek/อัปเดตตำแหน่ง)
        // เดิมฟังก์ชันนี้เซ็ต src รูป/สร้าง marquee ใหม่ทุกครั้งที่ event ยิง แม้เพลงเดิม ทำให้รูปกับชื่อเพลงกระพริบถี่ๆ
        // เลยจำ track id ล่าสุดไว้ แล้วอัปเดตส่วนที่ผูกกับ "เพลง" (รูปปก/ชื่อเพลง/marquee) เฉพาะตอนเพลงเปลี่ยนจริงเท่านั้น
        let _lastPlayerUiTrackId = null;
        function updatePlayerUI(state) {
            if (!state) return;
            const track = state.track_window.current_track; if (!track) return;
            const trackChanged = track.id !== _lastPlayerUiTrackId;
            if (trackChanged) {
                _lastPlayerUiTrackId = track.id;
                document.getElementById('player-art').src = track.album.images[0]?.url;
                document.getElementById('player-art').classList.remove('hidden');
                document.getElementById('player-title').textContent = track.name;
                const modalArt = document.getElementById('lyrics-modal-art');
                if (modalArt) { modalArt.crossOrigin = 'anonymous'; modalArt.src = track.album.images[0]?.url; modalArt.onload = () => extractAndApplyColor(modalArt); if (modalArt.complete && modalArt.naturalWidth > 0) extractAndApplyColor(modalArt); }
                const modalTitle = document.getElementById('lyrics-modal-title');
                if (modalTitle) {
                    const titleText = track.name;
                    modalTitle.innerHTML = `<span class="marquee-inner">${titleText}&nbsp;&nbsp;&nbsp;${titleText}</span>`;
                    requestAnimationFrame(() => { const inner = modalTitle.querySelector('.marquee-inner'); if (inner && inner.scrollWidth > modalTitle.clientWidth * 2 + 1) { modalTitle.classList.add('is-overflow'); } else { modalTitle.classList.remove('is-overflow'); modalTitle.innerHTML = `<span class="marquee-inner">${titleText}</span>`; } });
                }
            }
            window._currentExplicitTrackId = track.id;
            if (trackChanged) updateExplicitBadges(track);
            const iconPlay = document.getElementById('icon-play'), iconPause = document.getElementById('icon-pause');
            const modalIconPlay = document.getElementById('lyrics-icon-play'), modalIconPause = document.getElementById('lyrics-icon-pause');
            if (state.paused) { iconPlay.classList.remove('hidden'); iconPause.classList.add('hidden'); modalIconPlay?.classList.remove('hidden'); modalIconPause?.classList.add('hidden'); }
            else { iconPlay.classList.add('hidden'); iconPause.classList.remove('hidden'); modalIconPlay?.classList.add('hidden'); modalIconPause?.classList.remove('hidden'); }
        }
        function hslToRgb(h, s, l) { s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]; }
        function rgbToHue(r, g, b) { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0; if (max !== min) { const d = max - min; if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6; else if (max === g) h = ((b - r) / d + 2) / 6; else h = ((r - g) / d + 4) / 6; } return Math.round(h * 360); }
        // ------------------------------------------------------------
        // Palette จากปกอัลบั้ม: ดึงหลายสีจริงๆ ของภาพ แล้วเอาไปใช้เป็นพื้นหลัง
        // ------------------------------------------------------------
        function rgbToHsl(r, g, b) {
            r /= 255; g /= 255; b /= 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
            let h = 0, s = 0;
            if (max !== min) {
                const d = max - min;
                s = l > .5 ? d / (2 - max - min) : d / (max + min);
                if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
                h *= 60;
            }
            return [h, s * 100, l * 100];
        }
        const colorDist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

        // ดึงสีเด่นหลายสีที่ "ต่างกันจริง" จากภาพ (histogram + เลือกสีที่ห่างกัน)
        function extractPalette(imgEl, count = 5) {
            const size = 64;
            const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(imgEl, 0, 0, size, size);
            const data = ctx.getImageData(0, 0, size, size).data; // ถ้าภาพโดน CORS บล็อก จะ throw ตรงนี้
            const bins = new Map();
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] < 128) continue;
                const r = data[i], g = data[i + 1], b = data[i + 2];
                const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
                let e = bins.get(key); if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; bins.set(key, e); }
                e.n++; e.r += r; e.g += g; e.b += b;
            }
            const cands = [...bins.values()].filter(e => e.n >= 6).map(e => {
                const r = e.r / e.n, g = e.g / e.n, b = e.b / e.n;
                const max = Math.max(r, g, b), min = Math.min(r, g, b), sat = max ? (max - min) / max : 0;
                return { r, g, b, n: e.n, sat, score: e.n * (0.5 + sat) };
            }).sort((x, y) => y.score - x.score);
            const picked = [];
            for (const minDist of [60, 40, 24]) {           // ผ่อนเกณฑ์ความต่างสีลงถ้าภาพมีสีน้อย
                for (const c of cands) {
                    if (picked.length >= count) break;
                    if (picked.every(p => colorDist(p, c) > minDist)) picked.push(c);
                }
                if (picked.length >= count) break;
            }
            // สีสดขึ้นก่อน (จะได้ blob ใหญ่ๆ เป็นสีเด่น) สีเทา/ดำไว้ท้าย
            picked.sort((x, y) => ((y.sat > .2) - (x.sat > .2)) || (y.score - x.score));
            return picked;
        }

        // ปรับสีให้ไม่มืด/ไม่จางเกินไปเมื่อใช้เป็นพื้นหลัง แล้วเติมให้ครบ count สี
        function normalizePalette(picked, count = 5) {
            const out = picked.map(c => {
                let [h, s, l] = rgbToHsl(c.r, c.g, c.b);
                if (s > 15) s = Math.min(90, Math.max(40, s * 1.15));
                l = Math.min(62, Math.max(30, l));
                return hslToRgb(h, s, l);
            });
            if (!out.length) out.push(hslToRgb(220, 55, 42));
            const [bh, bs, bl] = rgbToHsl(...out[0]);
            const shifts = [40, -40, 80, -80, 120, -120];
            for (let i = 0; out.length < count; i++) out.push(hslToRgb((bh + shifts[i % shifts.length] + 360) % 360, Math.max(bs, 35), bl));
            return out.slice(0, count);
        }

        // สร้างชั้นพื้นหลัง blob สีไล่โทนของหน้าเนื้อเพลงไว้ล่วงหน้า (ใช้สีเริ่มต้นจาก CSS fallback var(--blobN, ...))
        // แทนที่จะรอให้ดึงสีจริงจากปกอัลบั้มเสร็จก่อน (โหลดรูป + ประมวลผลสี อาจช้าโดยเฉพาะบนมือถือ) เพราะเดิมชั้นนี้
        // (.modal-blobs) ถูกสร้างจาก applyPalette() เท่านั้น ถ้ายังไม่เคยรันเลยหน้าเนื้อเพลงจะเป็นพื้นมืดเปล่าๆ ค้างอยู่นาน
        function ensureLyricsBlobs() {
            const modal = document.getElementById('lyrics-modal'); if (!modal || modal.querySelector('.modal-blobs')) return;
            const blobLayer = document.createElement('div'); blobLayer.className = 'modal-blobs';
            blobLayer.innerHTML = [1, 2, 3, 4, 5].map(n => `<div class="blob blob-${n}"></div>`).join('');
            modal.insertBefore(blobLayer, modal.firstChild);
        }
        function applyPalette(palette) {
            tvS.palette = palette.map(c => [c[0], c[1], c[2]]); if (tvS.session) tvSchedulePush(600); // ส่งสีเดียวกันนี้ไปให้หน้าจอ TV
            const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
            document.documentElement.style.setProperty('--accent-glow', rgba(palette[0], 0.4));
            // พื้นหลังหน้าหลัก: ไล่สี 5 สีจากปก
            const mobile = window.matchMedia('(max-width: 768px)').matches;
            const k = mobile ? 1.7 : 1.2; // มือถือปรับให้สีเข้มขึ้น เพราะจอเล็กและแสงแดดทำให้สีจางลง
            const amb = document.getElementById('ambient-bg');
            if (amb) palette.forEach((c, i) => amb.style.setProperty(`--amb${i + 1}`, rgba(c, Math.min(.9, (i === 0 ? .42 : .32) * k))));
            // พื้นหลังหน้าเนื้อเพลง: blob 5 ก้อน ก้อนละสี
            const modal = document.getElementById('lyrics-modal'); if (!modal) return;
            palette.forEach((c, i) => modal.style.setProperty(`--blob${i + 1}`, rgba(c, Math.min(.95, (i < 3 ? .6 : .5) * (mobile ? 1.5 : 1)))));
            ensureLyricsBlobs();
        }
        let _lastPaletteSrc = '';
        function extractAndApplyColor(imgEl) {
            const src = imgEl.currentSrc || imgEl.src || '';
            if (src && src === _lastPaletteSrc) return;   // ปกเดิม ไม่ต้องคำนวณซ้ำทุกครั้งที่ state เปลี่ยน
            _lastPaletteSrc = src;
            try {
                applyPalette(normalizePalette(extractPalette(imgEl)));
            } catch (e) {
                // ถ้าอ่านพิกเซลไม่ได้ (CORS) ใช้สีจาก hash ของ URL แทน
                let hash = 0; for (let i = 0; i < src.length; i++) hash = src.charCodeAt(i) + ((hash << 5) - hash);
                const hue = Math.abs(hash) % 360;
                applyPalette([0, 45, -45, 90, -90].map(d => hslToRgb((hue + d + 360) % 360, 65, 45)));
            }
        }
        // ============================================================
        // ประวัติการนำทาง (ปุ่มย้อนกลับของเบราว์เซอร์/มือถือ)
        //  - แต่ละหน้า (Home/Search/Ranking/ศิลปิน/อัลบั้ม) และหน้าต่างซ้อน (เนื้อเพลง/TV/ส่งเพลง/เพลย์ลิสต์) เป็น 1 รายการในประวัติ
        //  - กดย้อนกลับ = ปิดหน้าต่างซ้อนก่อน แล้วค่อยย้อนไปหน้าก่อนหน้า ทีละขั้น
        //  - ถึงหน้าหลักแล้วกดย้อนกลับ จะไม่ออกจากแอปทันที ต้องกดซ้ำอีกครั้งภายใน 2.5 วินาที
        // ============================================================
        const NAV = { ready: false, restoring: false, exitArmed: false, exitTimer: null, artistId: '', albumId: '', developerSoundId: '' };
        const currentViewId = () => document.querySelector('.view.active')?.id || 'view-home';
        const $el = id => document.getElementById(id);
        let resetLyricsControlsTimer = () => {};

        const OVERLAYS = {
            lyrics: {
                isOpen: () => !$el('lyrics-modal').classList.contains('hidden'),
                set: on => {
                    const modal = $el('lyrics-modal');
                    if (on) { modal.classList.remove('hidden'); ensureLyricsBlobs(); modal.requestFullscreen?.().catch(() => { }); closeLyricsMoreMenu(); resetLyricsControlsTimer(); return; }
                    closeLyricsMoreMenu();
                    if (carModeActive) exitCarMode(); // ปิดหน้าเนื้อเพลงทั้งที ต้องออกจากโหมดรถให้เรียบร้อยด้วย ไม่งั้นจอจะค้างแนวนอน/ล็อกอยู่
                    if (document.fullscreenElement) document.exitFullscreen().catch(() => { }).finally(() => modal.classList.add('hidden'));
                    else modal.classList.add('hidden');
                    resetLyricsControlsTimer();
                }
            },
            rank: { isOpen: () => !$el('ranking-modal').classList.contains('hidden'), set: on => { $el('ranking-modal').classList.toggle('hidden', !on); if (!on) rankingPick = null; } },
            tv: { isOpen: () => !$el('tv-modal').classList.contains('hidden'), set: on => { $el('tv-modal').classList.toggle('hidden', !on); if (!on) tvHelloStop(); } },
            playlist: { isOpen: () => !$el('playlist-modal').classList.contains('hidden'), set: on => $el('playlist-modal').classList.toggle('hidden', !on) }
        };

        function overlayOpen(name) {
            const o = OVERLAYS[name]; if (!o || o.isOpen()) return;
            // ป็อปอัพอื่น (เช่น เพิ่มเข้าเพลย์ลิสต์) เป็นพี่น้องของ lyrics-modal ใน DOM ไม่ใช่ลูก
            // ตอน lyrics-modal อยู่ในโหมดเต็มจอจริงของเบราว์เซอร์ พี่น้องจะไม่ถูกวาดทับขึ้นมาแม้ z-index จะสูงกว่า จึงต้องออกจากเต็มจอก่อน
            if (name !== 'lyrics' && document.fullscreenElement) document.exitFullscreen().catch(() => { });
            o.set(true);
            if (!NAV.ready) return;
            const base = history.state?.app ? history.state : { app: 1, v: currentViewId(), id: '' };
            history.pushState({ ...base, o: name }, '');
        }
        function overlayClose(name) {
            const o = OVERLAYS[name]; if (!o || !o.isOpen()) return;
            o.set(false);
            // ปิดป็อปอัพที่ซ้อนอยู่แล้ว กลับเข้าเต็มจอเนื้อเพลงต่อ ถ้าหน้าเนื้อเพลงยังเปิดอยู่
            if (name !== 'lyrics' && OVERLAYS.lyrics.isOpen() && !document.fullscreenElement) document.getElementById('lyrics-modal').requestFullscreen?.().catch(() => { });
            if (NAV.ready && history.state?.o === name) history.back(); // เอารายการของหน้าต่างนี้ออกจากประวัติ
        }
        // ============================================================
        // เมนู "เพิ่มเติม" ในหน้าเนื้อเพลง (ปุ่มจุดไข่ปลา 3 จุด)
        // ============================================================
        let sleepTimer = null, sleepAt = 0, sleepLabelTimer = null;

        function closeLyricsMoreMenu() { document.getElementById('lyrics-more-menu')?.classList.add('hidden'); }

        function askText(title, defaultValue) {
            return new Promise(resolve => {
                const modal = document.getElementById('text-prompt-modal'), input = document.getElementById('text-prompt-input');
                document.getElementById('text-prompt-title').textContent = title;
                input.value = defaultValue || '';
                // ป็อปอัพนี้เป็นพี่น้องของ lyrics-modal ใน DOM เช่นกัน ต้องออกจากโหมดเต็มจอก่อน ไม่งั้นจะถูกเนื้อเพลงบังเหมือนที่เคยเป็นกับหน้าต่างเพลย์ลิสต์
                if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
                modal.classList.remove('hidden');
                requestAnimationFrame(() => { input.focus(); input.select(); });
                const done = val => {
                    modal.classList.add('hidden'); ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel); input.removeEventListener('keydown', onKey);
                    if (OVERLAYS.lyrics.isOpen() && !document.fullscreenElement) document.getElementById('lyrics-modal').requestFullscreen?.().catch(() => { });
                    resolve(val);
                };
                const ok = document.getElementById('text-prompt-ok'), cancel = document.getElementById('text-prompt-cancel');
                const onOk = () => done(input.value.trim());
                const onCancel = () => done(null);
                const onKey = e => { if (e.key === 'Enter') onOk(); else if (e.key === 'Escape') onCancel(); };
                ok.addEventListener('click', onOk); cancel.addEventListener('click', onCancel); input.addEventListener('keydown', onKey);
            });
        }

        async function createPlaylistWithTrack(track) {
            if (!track) return;
            const name = (await askText('ตั้งชื่อเพลย์ลิสต์ใหม่', track.name ? `เพลย์ลิสต์ของ ${track.name}` : '') || '').trim();
            if (!name) return;
            try {
                const user = currentUser || await getUserProfile();
                const pl = await fetchWebApi(`v1/users/${user.id}/playlists`, 'POST', { name, public: false });
                await fetchWebApi(`v1/playlists/${pl.id}/tracks`, 'POST', { uris: [track.uri || `spotify:track:${track.id}`] });
                showToast(`✅ สร้างเพลย์ลิสต์ "${name}" แล้ว`, 'info');
            } catch (e) { console.error('Create playlist error:', e); showToast('❌ สร้างเพลย์ลิสต์ไม่สำเร็จ', 'error'); }
        }

        async function shareTrack(track) {
            if (!track) return;
            const url = `https://open.spotify.com/track/${track.id}`;
            if (navigator.share) { try { await navigator.share({ title: track.name, text: track.artists?.map(a => a.name).join(', '), url }); return; } catch (e) { return; } }
            try { await navigator.clipboard.writeText(url); showToast('✅ คัดลอกลิงก์เพลงแล้ว', 'info'); } catch (e) { showToast(url, 'info'); }
        }

        function sleepLabelUpdate() {
            const label = document.getElementById('menu-sleep-label'); if (!label) return;
            if (!sleepTimer) { label.textContent = 'ตั้งเวลาหยุดเล่น'; clearInterval(sleepLabelTimer); return; }
            const left = Math.max(0, Math.round((sleepAt - Date.now()) / 60000));
            label.textContent = `หยุดเล่นใน ${left} นาที (แตะเพื่อยกเลิก)`;
        }
        function cancelSleepTimer() { clearTimeout(sleepTimer); sleepTimer = null; sleepLabelUpdate(); showToast('ยกเลิกการตั้งเวลาหยุดเล่นแล้ว', 'info'); }
        function setSleepTimer(minutes) {
            clearTimeout(sleepTimer);
            sleepAt = Date.now() + minutes * 60000;
            sleepTimer = setTimeout(() => { playbackPause(); sleepTimer = null; sleepLabelUpdate(); showToast('⏸ หยุดเล่นตามเวลาที่ตั้งไว้', 'info'); }, minutes * 60000);
            clearInterval(sleepLabelTimer); sleepLabelTimer = setInterval(sleepLabelUpdate, 30000);
            sleepLabelUpdate();
            showToast(`🌙 ตั้งเวลาหยุดเล่นใน ${minutes} นาทีแล้ว`, 'info');
        }

        function renderSleepOptions() {
            const box = document.getElementById('lyrics-more-menu'); if (!box) return;
            const opts = [5, 15, 30, 60];
            box.innerHTML = `
    <button type="button" class="lyrics-more-item" id="sleep-back"><span class="lyrics-more-item-icon"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M20,11V13H8L13.5,18.5L12.08,19.92L4.16,12L12.08,4.08L13.5,5.5L8,11H20Z"/></svg></span><span>กลับ</span></button>
    <div class="lyrics-more-sep"></div>
    ${opts.map(m => `<button type="button" class="lyrics-more-item sleep-opt" data-min="${m}"><span>${m} นาที</span></button>`).join('')}
    <button type="button" class="lyrics-more-item sleep-opt" data-min="track"><span>จบเพลงนี้</span></button>
    ${sleepTimer ? '<div class="lyrics-more-sep"></div><button type="button" class="lyrics-more-item" id="sleep-cancel"><span>ยกเลิกการตั้งเวลา</span></button>' : ''}
  `;
            box.querySelector('#sleep-back').onclick = renderMainMenu;
            box.querySelectorAll('.sleep-opt').forEach(b => b.onclick = () => {
                const v = b.dataset.min;
                if (v === 'track') { const d = seekState.duration, p = currentSeekPosition(); setSleepTimer(Math.max(0.1, (d - p) / 60000)); }
                else setSleepTimer(Number(v));
                closeLyricsMoreMenu();
            });
            box.querySelector('#sleep-cancel')?.addEventListener('click', () => { cancelSleepTimer(); closeLyricsMoreMenu(); });
        }

        function renderMainMenu() {
            const box = document.getElementById('lyrics-more-menu'); if (!box) return;
            box.innerHTML = document.getElementById('lyrics-more-menu-template').innerHTML;
            bindMainMenuEvents();
            sleepLabelUpdate(); // ถ้ามีการตั้งเวลาหยุดเล่นค้างอยู่ ให้ป้ายในเมนูขึ้นเวลานับถอยหลังทันทีตอนเปิดเมนูใหม่
        }

        function bindMainMenuEvents() {
            document.getElementById('menu-add-to-playlist')?.addEventListener('click', () => { closeLyricsMoreMenu(); if (currentTrackData) { currentContextTrack = currentTrackData; document.getElementById('menu-add-playlist').click(); } });
            document.getElementById('menu-new-playlist')?.addEventListener('click', () => { closeLyricsMoreMenu(); createPlaylistWithTrack(currentTrackData); });
            document.getElementById('menu-share-track')?.addEventListener('click', () => { closeLyricsMoreMenu(); shareTrack(currentTrackData); });
            document.getElementById('menu-sleep-timer')?.addEventListener('click', renderSleepOptions);
            document.getElementById('menu-car-mode')?.addEventListener('click', () => {
                closeLyricsMoreMenu();
                // ป็อปอัพนี้เป็นพี่น้องของ lyrics-modal ใน DOM เช่นกัน (เหมือน playlist-modal/text-prompt-modal)
                // ต้องออกจากโหมดเต็มจอก่อน ไม่งั้นจะถูกเนื้อเพลงที่เต็มจออยู่บังจนมองไม่เห็นเลย
                if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
                document.getElementById('car-mode-confirm')?.classList.remove('hidden');
            });
        }

        // ============================================================
        // โหมดรถ — สะท้อนเนื้อเพลงขึ้นกระจกหน้ารถ (วางโทรศัพท์/แท็บเล็ตคว่ำหน้าจอขึ้นบนคอนโซล)
        // จอแนวนอน, พื้นดำ, ไม่มีชื่อเพลง/ปก/คอนโทรล เหลือแค่เนื้อเพลงตรงกลาง และ "กลับด้านซ้าย-ขวา" ตั้งใจ
        // เพื่อให้อ่านถูกทิศทางตอนมองผ่านการสะท้อนบนกระจก
        // ============================================================
        let carModeActive = false;
        async function enterCarMode() {
            carModeActive = true;
            const modal = document.getElementById('lyrics-modal');
            modal.classList.add('car-mode');
            document.getElementById('btn-car-mode-exit')?.classList.remove('hidden');
            document.querySelector('am-lyrics')?.classList.add('car-mode'); // ให้ CSS ฝั่งใน shadow DOM ของวิดเจ็ตจัดกึ่งกลาง/ขยายตัวอักษรด้วย
            try { await modal.requestFullscreen?.(); } catch (e) { }
            try { await screen.orientation?.lock?.('landscape'); } catch (e) { } // ใช้ได้เฉพาะมือถือ/แท็บเล็ตบางรุ่น เดสก์ท็อป/บางเบราว์เซอร์จะ throw เฉยๆ ไม่เป็นไร
        }
        async function exitCarMode() {
            carModeActive = false;
            document.getElementById('lyrics-modal')?.classList.remove('car-mode');
            document.getElementById('btn-car-mode-exit')?.classList.add('hidden');
            document.querySelector('am-lyrics')?.classList.remove('car-mode');
            try { screen.orientation?.unlock?.(); } catch (e) { }
            resetLyricsControlsTimer();
        }
        function setupCarMode() {
            document.getElementById('car-mode-cancel')?.addEventListener('click', () => {
                document.getElementById('car-mode-confirm')?.classList.add('hidden');
                // ยกเลิก: กลับเข้าเต็มจอเนื้อเพลงต่อ ถ้าหน้าเนื้อเพลงยังเปิดอยู่ (เหมือน overlayClose/askText)
                if (OVERLAYS.lyrics.isOpen() && !document.fullscreenElement) document.getElementById('lyrics-modal').requestFullscreen?.().catch(() => { });
            });
            document.getElementById('car-mode-confirm-btn')?.addEventListener('click', () => { document.getElementById('car-mode-confirm')?.classList.add('hidden'); enterCarMode(); });
            document.getElementById('btn-car-mode-exit')?.addEventListener('click', exitCarMode);
        }

        function setupLyricsControlsAutoHide() {
            const modal = document.getElementById('lyrics-modal');
            if (!modal) return;

            const mobileQuery = window.matchMedia('(max-width: 768px)');
            let hideTimer;
            const showControls = () => {
                clearTimeout(hideTimer);
                modal.classList.remove('mobile-controls-idle');
                if (!mobileQuery.matches || carModeActive || !OVERLAYS.lyrics.isOpen()) return;
                hideTimer = setTimeout(() => {
                    if (mobileQuery.matches && !carModeActive && OVERLAYS.lyrics.isOpen()) {
                        modal.classList.add('mobile-controls-idle');
                    }
                }, 3000);
            };

            modal.addEventListener('pointerdown', showControls, { passive: true });
            modal.addEventListener('touchstart', showControls, { passive: true });
            modal.addEventListener('pointermove', event => {
                if (event.pointerType === 'mouse') showControls();
            }, { passive: true });
            document.addEventListener('keydown', showControls);
            mobileQuery.addEventListener('change', showControls);
            resetLyricsControlsTimer = showControls;
            showControls();
        }

        function setupLyricsMoreMenu() {
            const btn = document.getElementById('btn-lyrics-more'), box = document.getElementById('lyrics-more-menu');
            if (!btn || !box) return;
            // เก็บ HTML ตั้งต้นของเมนูไว้ ใช้สร้างกลับหลังออกจากเมนูย่อย (ตั้งเวลาหยุดเล่น)
            const tpl = document.createElement('template'); tpl.id = 'lyrics-more-menu-template'; tpl.innerHTML = box.innerHTML;
            document.body.appendChild(tpl);
            bindMainMenuEvents();
            btn.addEventListener('click', e => { e.stopPropagation(); const willOpen = box.classList.contains('hidden'); closeLyricsMoreMenu(); if (willOpen) { renderMainMenu(); box.classList.remove('hidden'); } });
            document.addEventListener('click', e => { if (!e.target.closest('.lyrics-more-wrap')) closeLyricsMoreMenu(); });
        }

        function toggleLyricsModal() { if (OVERLAYS.lyrics.isOpen()) overlayClose('lyrics'); else overlayOpen('lyrics'); }
        window.closePlaylistModal = () => overlayClose('playlist');

        // เรียกก่อนเปลี่ยนหน้าด้วยการกดของผู้ใช้ (ไม่เรียกตอนกู้หน้าจากปุ่มย้อนกลับ)
        function navGo(v, id = '') {
            if (!NAV.ready || NAV.restoring) return;
            const cur = history.state;
            if (cur?.app && cur.v === v && (cur.id || '') === id && !cur.o) return;
            history.pushState({ app: 1, v, id }, '');
        }

        function navInit() {
            if (NAV.ready) return; NAV.ready = true;
            history.replaceState({ guard: true }, '');                 // จุดเริ่มต้น: ย้อนถึงตรงนี้ = ผู้ใช้จะออกจากแอป
            history.pushState({ app: 1, v: 'view-home', id: '' }, '');
            window.addEventListener('popstate', navOnPop);
        }

        function navOnPop(e) {
            const st = e.state;
            const closeAll = () => Object.keys(OVERLAYS).forEach(n => { if (OVERLAYS[n].isOpen()) OVERLAYS[n].set(false); });
            if (!st || st.guard || !st.app) {
                // ย้อนกลับจากหน้าหลักสุด: กดซ้ำภายใน 2.5 วินาทีถึงจะออกจริง
                if (NAV.exitArmed) { NAV.exitArmed = false; clearTimeout(NAV.exitTimer); history.back(); return; }
                NAV.exitArmed = true;
                showToast('กดย้อนกลับอีกครั้งเพื่อออกจากแอป', 'info');
                NAV.exitTimer = setTimeout(() => { NAV.exitArmed = false; }, 2500);
                closeAll();
                NAV.restoring = true; try { showView('view-home'); } finally { NAV.restoring = false; }
                history.pushState({ app: 1, v: 'view-home', id: '' }, '');
                return;
            }
            NAV.restoring = true;
            try {
                Object.keys(OVERLAYS).forEach(n => { if (n !== st.o && OVERLAYS[n].isOpen()) OVERLAYS[n].set(false); });
                if (st.o && !OVERLAYS[st.o].isOpen()) history.replaceState({ ...st, o: undefined }, ''); // หน้าต่างที่เปิดกลับมาเองไม่ได้ ตัดออกจากสถานะ
                // หน้าศิลปิน/อัลบั้มใช้ตัวแสดงร่วมกัน: ถ้าเนื้อหาที่ค้างอยู่เป็นของ id นี้ก็แค่สลับหน้า ไม่ต้องโหลดใหม่
                if (st.v === 'view-artist' && st.id) { if (NAV.artistId === st.id) showView('view-artist'); else handleArtistClick(st.id); }
                else if (st.v === 'view-album' && st.id) { if (NAV.albumId === st.id) showView('view-album'); else handleAlbumClick(st.id); }
                else if (st.v === 'view-developer-sound' && st.id) {
                    const sound = developerSoundsCache.find(item => item.id === st.id);
                    if (NAV.developerSoundId === st.id) showView('view-developer-sound');
                    else if (sound) handleDeveloperSoundClick(sound);
                    else showView('view-home');
                }
                else if (st.v !== currentViewId()) showView(st.v);
            } finally { NAV.restoring = false; }
        }

        function showToast(message, type = 'info') {
            // ข้อความแจ้งเตือนต้องอยู่ในหน้าเนื้อเพลงตอนที่มันเต็มจอจริงของเบราว์เซอร์ ไม่งั้นจะถูกบังจนมองไม่เห็น (เหมือนที่เคยเป็นกับป็อปอัพอื่น)
            const host = document.fullscreenElement || document.body;
            let container = document.getElementById('toast-container');
            if (!container) { container = document.createElement('div'); container.id = 'toast-container'; container.className = 'toast-container'; host.appendChild(container); }
            else if (container.parentElement !== host) host.appendChild(container);
            const toast = document.createElement('div'); toast.className = `toast toast-${type}`; toast.textContent = message;
            container.appendChild(toast);
            requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
            setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(20px)'; setTimeout(() => toast.remove(), 300); }, 3000);
        }

        // ============================================================
        // LYRICS
        // ============================================================
        let lyricsUpdateInterval;
        function updateLyricsComponent(positionMs, durationMs, paused) {
            clearInterval(lyricsUpdateInterval);
            const lyricsEl = document.querySelector('am-lyrics'); if (!lyricsEl) return;
            if (positionMs !== undefined) {
                lyricsEl.setAttribute('current-time', positionMs);
                lyricsEl.setAttribute('duration', paused ? -1 : durationMs);
                updateLyricsWriterCredit(positionMs, durationMs, currentTrackData?.id, lyricsEl);
            }
            if (!paused && positionMs !== undefined) {
                let currentPos = positionMs, lastTime = performance.now();
                lyricsUpdateInterval = setInterval(() => {
                    const now = performance.now(); currentPos += (now - lastTime); lastTime = now;
                    lyricsEl.setAttribute('current-time', currentPos);
                    lyricsEl.currentTime = currentPos;
                    updateLyricsWriterCredit(currentPos, durationMs, currentTrackData?.id, lyricsEl);
                }, 100);
            }
        }
        // ---------- หาเนื้อเพลงที่ "ซิงก์ตามเวลา" ----------
        // 1) ให้ <am-lyrics> ค้นหาก่อน (ส่งชื่อเพลง/ศิลปิน/อัลบั้ม/ISRC/ความยาว เพื่อให้จับคู่ถูกเวอร์ชัน)
        // 2) ถ้าได้แต่เนื้อเพลงเปล่า ๆ (ไม่มีเวลา) หรือไม่เจอเลย -> ค้นหาเวอร์ชันซิงก์จาก LRCLIB เอง
        //    แล้วแปลงเป็น TTML ส่งให้ <am-lyrics> แสดงผล
        const THAI_COMBINING = /^[\u0E31\u0E33-\u0E3A\u0E47-\u0E4E]+$/; // สระบน/ล่าง วรรณยุกต์ ฯลฯ ที่ต้องติดกับพยัญชนะตัวหน้า
        const THAI_LEADING = /^[\u0E40-\u0E44]+$/; // สระหน้า เ แ โ ไ ใ ที่ต้องติดกับพยัญชนะตัวหลัง
        // วิดเจ็ตรุ่นใหม่ห่อ <span class="char"> ด้วย <span class="char-motion"> (ตัวที่ขยับ/เรืองแสง) จึงต้องไล่หาเพื่อนบ้านที่ระดับ wrapper
        const charUnit = el => (el.parentElement && el.parentElement.classList.contains('char-motion')) ? el.parentElement : el;
        function adjacentChar(span, dir) {
            let u = charUnit(span)[dir];
            while (u) {
                const c = u.classList.contains('char') ? u : u.querySelector('.char');
                if (c && c.style.display !== 'none' && u.style.display !== 'none') return c;
                u = u[dir];
            }
            return null;
        }
        function glueThai(target, text, atStart) {
            target.textContent = atStart ? text + target.textContent : target.textContent + text;
            target.setAttribute('data-glyph', target.textContent); // เลเยอร์เรืองแสง (::after) ใช้ data-glyph วาดซ้ำ ต้องอัปเดตให้ตรงกับข้อความใหม่
            ['width:auto', 'min-width:auto', 'max-width:none', 'overflow:visible', 'white-space:pre'].forEach(d => { const [k, v] = d.split(':'); target.style.setProperty(k, v, 'important'); });
        }
        function hideThai(span) {
            span.textContent = ''; span.style.display = 'none'; span.removeAttribute('data-glow'); span.classList.remove('native-motion');
            const w = charUnit(span); if (w !== span) w.style.display = 'none'; // ซ่อน wrapper ด้วย ไม่งั้นยังเหลือกล่องว่างที่ขยับ/เรืองแสงแยกเอง
        }
        function fixThaiSpans(root) {
            root.querySelectorAll('.char:not(.th-ok)').forEach(span => {
                span.classList.add('th-ok');
                const t = span.textContent; if (!t) return;
                if (THAI_COMBINING.test(t)) { const prev = adjacentChar(span, 'previousElementSibling'); if (prev) { glueThai(prev, t, false); hideThai(span); } }
                else if (THAI_LEADING.test(t)) { const next = adjacentChar(span, 'nextElementSibling'); if (next) { glueThai(next, t, true); hideThai(span); } }
            });
        }

        // CSS ที่ฉีดเข้า shadow DOM ของ <am-lyrics> เพื่อแก้บรรทัดถัดไปเลื่อนหลุดขึ้นไปบนสุด
        //  1) ตำแหน่งบรรทัดที่กำลังร้อง เดิมอยู่ 8-12% จากขอบบน ซึ่งตรงกับโซนที่ถูกมาสก์ให้จางหาย (ดู .lyrics-right) จึงมองไม่เห็น
        //  2) บรรทัดที่มีท่อนร้องประสาน เช่น "(สวัสดี)" จะกางความสูงออกทีหลัง ทำให้ระยะเลื่อนที่คำนวณไว้คลาดเคลื่อน จึงล็อกความสูงให้คงที่
        const LYRICS_SHADOW_CSS = `
.lyrics-container { --lyrics-scroll-padding-top: 26% !important; }
@media (max-width: 700px) {
  .lyrics-container { --lyrics-scroll-padding-top: 16% !important; }
}
.background-vocal-container { height: auto !important; transition: none !important; }
.background-vocal-wrap { opacity: .55 !important; transform: none !important; }
.lyrics-line.bg-expanded .background-vocal-wrap { opacity: 1 !important; }
.lyrics-line.bg-expanded.bg-after .main-vocal-container,
.lyrics-line.bg-expanded.bg-before .main-vocal-container { transform: none !important; }
/* ซ่อนแถบเครื่องมือและเครดิตภายในวิดเจ็ต; แสดงเครดิตผู้แต่งในแถบด้านนอกแทน */
.lyrics-header, .widget-header { display: none !important; }
.lyrics-footer > div:not(.songwriters-info) { display: none !important; }
.songwriters-info { display: none !important; }
/* ภาษาไทย: วรรณยุกต์/สระบน-ล่างล้นกล่อง .char แล้วโดน background-clip:text ตัดหายหรือกะพริบ — ขยายกล่องขึ้นลงโดยไม่ขยับตัวอักษร
   (เลเยอร์เรืองแสง ::after ต้องมี padding เท่ากัน ไม่งั้นแสงจะเลื่อนขึ้นไปจากตัวอักษรจริง) */
.lyrics-syllable span.char { padding-block: .45em !important; margin-block: -.45em !important; }
.lyrics-syllable .char.native-motion[data-glow]::after { padding-block: .45em !important; }
/* เผื่อพื้นที่ท้ายเนื้อเพลงให้เลื่อนบรรทัดสุดท้ายพ้นขอบล่าง */
.lyrics-container { padding-bottom: 45vh !important; }
/* โหมดรถ: จัดเนื้อเพลงให้อยู่กึ่งกลางจอ ตัวใหญ่ขึ้น อ่านง่ายจากระยะไกล/ตอนสะท้อนบนกระจก
   toggle คลาส "car-mode" ที่ตัว <am-lyrics> (host) จากฝั่งนอก แล้วใช้ :host() เลือก element ข้างในของ shadow DOM ได้ */
:host(.car-mode) .lyrics-container { --lyrics-scroll-padding-top: 45% !important; }
:host(.car-mode) .lyrics-line { text-align: center !important; justify-content: center !important; }
:host(.car-mode) .lyrics-line.active { font-size: calc(var(--lyplus-font-size-base) * 1.35) !important; }
`;

        // เปลี่ยนป้าย "Songwriters" ของวิดเจ็ตเป็น "แต่งโดย:" ในบรรทัดเครดิตท้ายเนื้อเพลง
        function relabelSongwriters(root) {
            const b = root.querySelector('.songwriters-info b');
            if (b && b.textContent !== 'แต่งโดย:') b.textContent = 'แต่งโดย:';
        }

        function extractLyricsWriter(root) {
            const labels = /^(?:songwriters?|written\s+by|แต่งโดย)\s*:\s*(.+)$/i;
            const matches = [...root.querySelectorAll('*')]
                .map(node => node.textContent.trim())
                .filter(text => text.length < 300 && labels.test(text))
                .sort((a, b) => a.length - b.length);
            return matches[0]?.replace(labels, '$1').trim() || '';
        }

        function setLyricsWriterCredit(track, text) {
            const credit = document.getElementById('lyrics-writer-credit');
            if (!credit || credit.dataset.trackId !== track.id) return;
            credit.dataset.creditText = text || 'ไม่พบข้อมูลผู้แต่ง';
            const label = document.createElement('strong');
            label.textContent = 'แต่งโดย: ';
            credit.replaceChildren(label, document.createTextNode(credit.dataset.creditText));
            credit.classList.toggle('hidden', credit.dataset.completed !== 'true');
        }

        function updateLyricsWriterCredit(positionMs, durationMs, trackId, lyricsEl) {
            const credit = document.getElementById('lyrics-writer-credit');
            if (!credit || !trackId || credit.dataset.trackId !== trackId || !durationMs) return;
            const rows = lyricsEl?.lyrics || [];
            const lyricEnd = rows.reduce((latest, row) => Math.max(latest, Number(row.endtime) || Number(row.timestamp) || 0), 0);
            const completed = positionMs >= (lyricEnd || durationMs);
            credit.dataset.completed = String(completed);
            if (!credit.textContent) {
                const label = document.createElement('strong');
                label.textContent = 'แต่งโดย: ';
                credit.replaceChildren(label, document.createTextNode(credit.dataset.creditText || 'ไม่พบข้อมูลผู้แต่ง'));
            }
            credit.classList.toggle('hidden', !completed);
        }

        function syncLyricsWriterCredit(lyricsEl, track, unavailable = false) {
            if (!track || !lyricsEl.shadowRoot) return;
            const names = extractLyricsWriter(lyricsEl.shadowRoot);
            if (names) { setLyricsWriterCredit(track, names); return; }
            if (unavailable) setLyricsWriterCredit(track, 'ไม่พบข้อมูลผู้แต่ง');
        }

        // แสดงเครดิตจากผู้ให้บริการเนื้อเพลงด้านนอกพื้นที่เลื่อน เพื่อไม่ให้ถูกตัดหรือจางหายที่ขอบ
        function mountLyricsEl(container, attrs, track) {
            container.innerHTML = '';
            const el = document.createElement('am-lyrics');
            if (carModeActive) el.classList.add('car-mode'); // รักษาสถานะโหมดรถไว้ข้ามการ mount ใหม่ทุกครั้งที่เปลี่ยนเพลง
            Object.entries(attrs).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') el.setAttribute(k, String(v)); });
            el.setAttribute('auto-scroll', 'true'); el.setAttribute('interpolate', 'true'); el.setAttribute('font-family', "'Kanit', sans-serif");
            container.appendChild(el);
            const waitForShadow = setInterval(() => {
                if (!el.isConnected) { clearInterval(waitForShadow); return; }
                if (el.shadowRoot) {
                    clearInterval(waitForShadow);
                    const st = document.createElement('style'); st.textContent = LYRICS_SHADOW_CSS; el.shadowRoot.appendChild(st);
                    fixThaiSpans(el.shadowRoot); relabelSongwriters(el.shadowRoot); syncLyricsWriterCredit(el, track);
                    new MutationObserver(() => { fixThaiSpans(el.shadowRoot); relabelSongwriters(el.shadowRoot); syncLyricsWriterCredit(el, track); }).observe(el.shadowRoot, { childList: true, characterData: true, subtree: true });
                }
            }, 50);
            return el;
        }

        // รอให้ <am-lyrics> โหลดเสร็จ แล้วบอกว่าได้เนื้อเพลงแบบไหน: 'synced' | 'unsynced' | 'none'
        function waitLyricsResult(el, timeoutMs = 12000) {
            return new Promise(resolve => {
                const start = Date.now(); let seenLoading = false;
                const tick = () => {
                    if (!el.isConnected) return resolve('gone');
                    const loading = !!el.isLoading; if (loading) seenLoading = true;
                    const elapsed = Date.now() - start;
                    if ((seenLoading && !loading) || (!loading && elapsed > 3000) || elapsed > timeoutMs) {
                        const ls = el.lyrics;
                        if (!ls || !ls.length) return resolve('none');
                        return resolve(ls.every(l => l.timestamp === 0 && l.endtime === 0) ? 'unsynced' : 'synced');
                    }
                    setTimeout(tick, 300);
                };
                tick();
            });
        }

        // LRCLIB ก็โดน 429 ได้เหมือนกันถ้าค้นเนื้อเพลงถี่ ๆ (สลับเพลงเร็ว ๆ) — คิวคำขอให้เรียงกัน
        // + เจอ 429 ก็หยุดรอตาม Retry-After แล้วลองใหม่อีก 1 ครั้งเอง (ไม่ต้องให้ผู้ใช้กดใหม่)
        let lrclibRateLimitUntil = 0;
        let lrclibQueue = Promise.resolve();
        async function lrclibJson(path, _retried) {
            const execute = async () => {
                const wait = lrclibRateLimitUntil - Date.now();
                if (wait > 0) await new Promise(r => setTimeout(r, wait));
                let res;
                try { res = await fetch(`https://lrclib.net/api/${path}`); }
                catch (e) { return null; } // ออฟไลน์ / โดนบล็อก — ไม่ลองซ้ำ เดี๋ยวรอนาน
                if (res.status === 429) {
                    const retryAfter = Math.min(15, Math.max(1, Number(res.headers.get('Retry-After')) || 3));
                    lrclibRateLimitUntil = Math.max(lrclibRateLimitUntil, Date.now() + retryAfter * 1000);
                    if (!_retried) { await new Promise(r => setTimeout(r, retryAfter * 1000)); return lrclibJson(path, true); }
                    return null;
                }
                if (!res.ok) return null;
                try { return await res.json(); } catch (e) { return null; }
            };
            return new Promise(resolve => {
                lrclibQueue = lrclibQueue.then(async () => {
                    resolve(await execute());
                    await new Promise(r => setTimeout(r, 120)); // เว้นจังหวะระหว่างคำขอ กันยิงรัวจนโดน 429 ซ้ำ
                }).catch(() => resolve(null));
            });
        }

        // หาเนื้อเพลงซิงก์จาก LRCLIB ลองหลายรูปแบบชื่อ และเลือกเวอร์ชันที่ความยาวใกล้เคียงกับเพลงที่เล่นอยู่ (กันเวลาเพี้ยน)
        async function findSyncedLrc(track) {
            const durSec = Math.round((track.duration_ms || 0) / 1000);
            const artist = track.artists?.[0]?.name || '';
            const album = track.album?.name || '';
            const raw = track.name || '';
            const titles = [...new Set([raw, raw.split(' - ')[0], raw.replace(/\s*[\(\[].*?[\)\]]/g, ''), raw.split(' - ')[0].split(' (')[0]].map(t => t.trim()).filter(Boolean))];
            const seen = new Map();
            const add = list => (Array.isArray(list) ? list : [list]).forEach(r => { if (r && r.syncedLyrics && !seen.has(r.id)) seen.set(r.id, r); });

            for (const t of titles.slice(0, 2)) {
                const p = new URLSearchParams({ track_name: t, artist_name: artist, album_name: album }); if (durSec) p.set('duration', durSec);
                add(await lrclibJson(`get?${p}`));
                if (seen.size) break;
            }
            if (!seen.size) {
                for (const t of titles) {
                    add(await lrclibJson(`search?${new URLSearchParams({ track_name: t, artist_name: artist })}`));
                    if (seen.size) break;
                    add(await lrclibJson(`search?${new URLSearchParams({ q: `${artist} ${t}` })}`));
                    if (seen.size) break;
                }
            }
            const cands = [...seen.values()];
            if (!cands.length) return null;
            if (!durSec) return cands[0];
            const scored = cands.map(r => ({ r, diff: Math.abs((Number(r.duration) || 0) - durSec) })).sort((a, b) => a.diff - b.diff);
            return scored[0].diff <= 5 ? scored[0].r : null; // ห่างเกิน 5 วินาที = คนละเวอร์ชัน เวลาจะเพี้ยน จึงไม่ใช้
        }

        // แปลง LRC ("[mm:ss.xx] ข้อความ") เป็น TTML ระดับบรรทัดที่ <am-lyrics> อ่านได้
        function lrcToTtml(lrc) {
            const rows = [];
            String(lrc).split(/\r?\n/).forEach(line => {
                const text = line.replace(/\[[^\]]*\]/g, '').trim();
                for (const m of line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) rows.push({ t: Number(m[1]) * 60 + parseFloat(m[2]), text });
            });
            rows.sort((a, b) => a.t - b.t);
            const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const ps = [];
            rows.forEach((r, i) => {
                if (!r.text) return;
                const end = rows[i + 1] ? rows[i + 1].t : r.t + 5;
                ps.push(`<p begin="${r.t.toFixed(2)}s" end="${Math.max(end, r.t + 0.5).toFixed(2)}s">${esc(r.text)}</p>`);
            });
            return ps.length ? `<?xml version="1.0" encoding="UTF-8"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>${ps.join('')}</div></body></tt>` : '';
        }

        async function setupLyricsComponent(track) {
            const container = document.getElementById('lyrics-container');
            const writerCredit = document.getElementById('lyrics-writer-credit');
            writerCredit.dataset.trackId = track.id;
            writerCredit.dataset.completed = 'false';
            writerCredit.dataset.creditText = 'ไม่พบข้อมูลผู้แต่ง';
            writerCredit.textContent = '';
            writerCredit.classList.add('hidden');
            container.innerHTML = '<div class="lyrics-loading-spinner"><div class="lyrics-spinner"></div><div class="lyrics-loading-text">กำลังค้นหาเนื้อเพลง...</div></div>';
            setLyricsFoundState(true); // ตั้งต้นแบบมีเนื้อเพลงไว้ก่อนระหว่างค้นหา เผื่อเพลงก่อนหน้าไม่มีเนื้อเพลงค้าง class ไว้
            const stale = () => !!currentTrackData && currentTrackData.id !== track.id;
            const cleanTitle = track.name;
            const primaryArtist = track.artists[0].name;
            const album = track.album?.name || '';
            const queryStr = `${cleanTitle} ${primaryArtist} ${album}`.trim();
            let isrc = '';
            try { const fullTrack = await fetchWebApi(`v1/tracks/${track.id}`); if (fullTrack?.external_ids?.isrc) isrc = fullTrack.external_ids.isrc; } catch (e) { }
            if (stale()) return;

            const lyricsEl = mountLyricsEl(container, {
                'song-title': cleanTitle, 'song-artist': primaryArtist, 'song-album': album, 'song-duration': track.duration_ms,
                query: queryStr, isrc, romanize: "true", providers: "lrc.red,lrclib,netease"
            }, track);
            syncLyricsTime();

            const result = await waitLyricsResult(lyricsEl);
            if (result === 'synced') {
                syncLyricsWriterCredit(lyricsEl, track, true);
                return;
            }
            if (result === 'gone' || stale()) return;

            // ได้แต่เนื้อเพลงเปล่า ๆ หรือไม่เจอ -> หาเวอร์ชันซิงก์เอง
            const found = await findSyncedLrc(track);
            if (!found || stale() || !container.contains(lyricsEl)) {
                if (container.contains(lyricsEl)) {
                    container.innerHTML = '';
                    writerCredit.classList.add('hidden');
                    setLyricsFoundState(false);
                }
                return;
            }
            const ttml = lrcToTtml(found.syncedLyrics);
            if (!ttml) {
                if (container.contains(lyricsEl)) {
                    container.innerHTML = '';
                    writerCredit.classList.add('hidden');
                    setLyricsFoundState(false);
                }
                return;
            }
            const fallbackLyrics = mountLyricsEl(container, { 'song-title': cleanTitle, 'song-artist': primaryArtist, 'song-duration': track.duration_ms, ttml, romanize: "true" }, track);
            syncLyricsWriterCredit(fallbackLyrics, track, true);
            syncLyricsTime();
        }

        // ไม่มีเนื้อเพลงสำหรับเพลงนี้ -> ซ่อนแผงเนื้อเพลงทั้งหมด เหลือแค่หน้าเล่นเพลงปกติ (ปกอัลบั้ม/ชื่อเพลง/คอนโทรล)
        // เหมือนตอนเปิดเพลงที่ไม่มีเนื้อเพลงในแอปเพลงทั่วไป แทนที่จะโชว์กล่องข้อความ "ไม่มีเนื้อเพลง" ค้างอยู่
        function setLyricsFoundState(found) {
            document.querySelector('.lyrics-layout')?.classList.toggle('no-lyrics', !found);
        }

        // ตั้งเวลาปัจจุบันให้ <am-lyrics> ที่เพิ่งสร้างใหม่ทันที ไม่ต้องรอ state ถัดไปจาก Spotify
        function syncLyricsTime() {
            if (typeof seekState === 'undefined') return;
            updateLyricsComponent(currentSeekPosition(), seekState.duration, seekState.paused);
        }

        // ============================================================
        // SEEK BAR (แถบเลือกจุดเพลง) — ใช้ร่วมกันทั้ง Player ด้านล่างและหน้าเนื้อเพลง
        // ============================================================
        const seekState = { position: 0, duration: 0, paused: true, ts: 0, dragging: false };
        function fmtTime(ms) {
            const t = Math.max(0, Math.floor(ms / 1000));
            const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
            return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
        }
        function currentSeekPosition() {
            if (seekState.paused) return seekState.position;
            return Math.min(seekState.duration, seekState.position + (performance.now() - seekState.ts));
        }
        function renderSeek(posMs) {
            const d = seekState.duration;
            const pos = Math.max(0, Math.min(d || 0, posMs));
            const pct = d ? pos / d : 0;
            document.querySelectorAll('.seek-row').forEach(row => {
                const bar = row.querySelector('.seek-bar');
                bar.disabled = !d;
                bar.value = Math.round(pct * 1000);
                bar.style.setProperty('--pct', `${pct * 100}%`);
                row.querySelector('.seek-current').textContent = fmtTime(pos);
                row.querySelector('.seek-remaining').textContent = '-' + fmtTime(d - pos);
            });
        }
        function syncSeekFromState(state) {
            if (!state) return;
            seekState.position = state.position; seekState.duration = state.duration;
            seekState.paused = state.paused; seekState.ts = performance.now();
            if (!seekState.dragging) renderSeek(state.position);
        }
        function setupSeekBars() {
            document.querySelectorAll('.seek-bar').forEach(bar => {
                // ระหว่างลาก: อัปเดตตัวเลขเวลาและแถบทุกอัน แต่ยังไม่สั่งเลื่อนเพลง
                bar.addEventListener('input', () => { seekState.dragging = true; renderSeek(bar.value / 1000 * seekState.duration); });
                // ปล่อยนิ้ว/เมาส์: สั่ง Spotify เลื่อนไปจุดนั้นจริง
                bar.addEventListener('change', async () => {
                    const pos = Math.round(bar.value / 1000 * seekState.duration);
                    seekState.position = pos; seekState.ts = performance.now(); seekState.dragging = false;
                    renderSeek(pos);
                    try { await playbackSeek(pos); }
                    catch (e) { console.error('Seek error:', e); showToast('❌ ไม่สามารถเลื่อนเพลงได้', 'error'); }
                    updateLyricsComponent(pos, seekState.duration, seekState.paused);
                });
            });
            // กันกรณีลากแล้วไม่มี change event (เช่น ปล่อยที่ค่าเดิม) ไม่ให้ค้างสถานะ dragging
            ['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, () => setTimeout(() => { seekState.dragging = false; }, 150)));
            // เดินเวลาต่อเองระหว่างที่ SDK ยังไม่ส่ง state ใหม่
            setInterval(() => { if (!document.hidden && !seekState.dragging && !seekState.paused && seekState.duration) renderSeek(currentSeekPosition()); }, 250);
            // ซิงก์กับ Player จริงทุก 5 วินาที กันเวลาเพี้ยน (เช่น บัฟเฟอร์)
            setInterval(async () => {
                if (!window._spotifyPlayer || remote.id || seekState.dragging || seekState.paused) return;
                try { syncSeekFromState(await window._spotifyPlayer.getCurrentState()); } catch (e) { }
            }, 5000);
        }

        // ============================================================
        // WAKE LOCK — กันหน้าจอล็อก/ดับอัตโนมัติระหว่างเปิดหน้าเนื้อเพลง
        // ============================================================
        let wakeLock = null, wakeLockWarned = false;
        const isLyricsOpen = () => !document.getElementById('lyrics-modal')?.classList.contains('hidden');
        async function requestWakeLock() {
            if (wakeLock || document.visibilityState !== 'visible') return;
            if (!navigator.wakeLock) {
                if (!wakeLockWarned) { wakeLockWarned = true; showToast('⚠️ เบราว์เซอร์นี้ไม่รองรับการกันหน้าจอดับ', 'warning'); }
                return;
            }
            try {
                const lock = await navigator.wakeLock.request('screen');
                if (!isLyricsOpen()) { lock.release().catch(() => { }); return; } // ปิดหน้าเนื้อเพลงไปแล้วระหว่างรอ
                wakeLock = lock;
                lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
            } catch (e) { console.warn('Wake lock error:', e.name, e.message); wakeLock = null; }
        }
        async function releaseWakeLock() {
            const lock = wakeLock; wakeLock = null;
            try { await lock?.release(); } catch (e) { }
        }
        function setupWakeLock() {
            const modal = document.getElementById('lyrics-modal'); if (!modal) return;
            // ดูการเปิด/ปิดหน้าเนื้อเพลงจาก class "hidden" ครอบคลุมทุกทาง (ปุ่ม Lyrics, ปุ่มปิด, ออกจากเต็มจอ)
            new MutationObserver(() => { if (isLyricsOpen()) requestWakeLock(); else releaseWakeLock(); }).observe(modal, { attributes: true, attributeFilter: ['class'] });
            // เบราว์เซอร์จะปล่อย wake lock เองเมื่อแท็บถูกซ่อน (สลับแอป/ปิดจอ) ต้องขอใหม่เมื่อกลับมา
            document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isLyricsOpen()) requestWakeLock(); });
        }

        // ============================================================
        // RANKING — จัดอันดับเพลง (Google Sheet + Apps Script)
        // ============================================================
        // URL ของ Apps Script Web App (ลงท้ายด้วย /exec) — วางตรงนี้ ไม่ต้องใส่ใน index.html
        const RANKING_API = 'https://script.google.com/macros/s/AKfycbyxZaws0vfMVlzZijyO8ukeYGKd2IOJ3Y5LAOvok3pgRLU2GdOabnoaA3On2UvFz1i1wg/exec'; // เช่น 'https://script.google.com/macros/s/xxxxxxxx/exec'
        const RANKING_REFRESH_MS = 30000;
        let rankingTimer = null, rankingPick = null, rankingBusy = false;
        let rankingTopics = [], rankingTopic = null; // หัวข้อจัดอันดับทั้งหมด / หัวข้อที่กำลังดูอยู่
        const RANKING_TOPIC_KEY = 'ranking_topic_id';

        const rkFmt = ms => { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
        const rkSafeUrl = u => (/^https:\/\//i.test(u || '') ? u : '');
        const rkEl = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
        // สัญลักษณ์ E = เพลงที่มีเนื้อหาไม่เหมาะสม (Explicit) ข้อมูลมาจาก Spotify
        const rkExplicitBadge = () => { const b = rkEl('span', 'rank-explicit', 'E'); b.title = 'เนื้อหาไม่เหมาะสม (Explicit)'; return b; };
        const RK_ERRORS = {
            unauthorized: 'เซสชันหมดอายุ กรุณาออกจากระบบแล้วเข้าใหม่',
            invalid_song: 'ข้อมูลเพลงไม่ถูกต้อง',
            invalid_cover: 'รูปปกไม่ถูกต้อง (ต้องเป็น PNG / JPG / GIF)',
            cover_too_large: 'รูปปกใหญ่เกิน 1.5MB',
            cover_type: 'ไฟล์รูปต้องเป็น PNG, JPG หรือ GIF เท่านั้น',
            busy: 'ระบบกำลังยุ่ง ลองใหม่อีกครั้ง',
            topic_not_found: 'ไม่พบหัวข้อนี้ (อาจถูกลบไปแล้ว) กรุณากดรีเฟรช',
            topic_closed: 'หัวข้อนี้ปิดโหวตแล้ว'
        };

        // GET (ไม่ส่ง payload) = ดึงหัวข้อ/อันดับ (query = { action, topic }), POST = ส่งเพลง/โหวต
        // ใช้ Content-Type: text/plain เพื่อไม่ให้เกิด CORS preflight (Apps Script ไม่รองรับ OPTIONS)
        async function rankingApi(payload, query) {
            if (!RANKING_API) throw new Error('no_api');
            let res;
            if (payload) {
                res = await fetch(RANKING_API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
            } else {
                const q = new URLSearchParams({ action: 'list', user: currentUser?.id || '', ...query, _: Date.now() });
                res = await fetch(`${RANKING_API}?${q}`);
            }
            if (!res.ok) throw new Error('http_' + res.status);
            return res.json();
        }

        function rankingNotice(box, text) { box.innerHTML = ''; box.appendChild(rkEl('div', 'rank-empty', text)); }

        function renderRanking(items) {
            const box = document.getElementById('ranking-list'); if (!box) return;
            box.innerHTML = '';
            if (!items?.length) { rankingNotice(box, rankingTopicClosed() ? 'หัวข้อนี้ปิดโหวตแล้วและยังไม่มีเพลงในอันดับ' : 'ยังไม่มีเพลงในหัวข้อนี้ — ค้นหาเพลงด้านบนแล้วเป็นคนแรกที่ส่งเลย! 🎵'); return; }
            const closed = rankingTopicClosed();
            // แสดงเป็นการ์ดปกเพลง เหมือนอัลบัม/ศิลปินในหน้าค้นหา
            items.slice(0, 20).forEach(it => {
                const card = rkEl('div', 'playlist-card rank-card' + (it.rank <= 3 ? ` top-${it.rank}` : ''));
                const cover = rkEl('div', 'rank-card-cover');
                const img = rkEl('img'); img.alt = it.title || ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
                img.src = rkSafeUrl(it.cover); img.onerror = () => img.classList.add('is-broken');
                cover.append(img, rkEl('span', 'rank-badge', String(it.rank)));
                const artistEl = rkEl('div', 'playlist-owner rank-card-artist');
                if (it.explicit) artistEl.appendChild(rkExplicitBadge());
                artistEl.appendChild(document.createTextNode(it.artist || '-'));
                const title = rkEl('div', 'playlist-title', it.title); title.title = it.title || '';
                const meta = rkEl('div', 'rank-card-meta');
                const votes = rkEl('div', 'rank-votes'); votes.append(rkEl('strong', '', String(it.votes)), rkEl('span', '', 'โหวต'));
                meta.append(votes, rkEl('div', 'rank-duration', it.duration || rkFmt(it.durationMs)));
                const btn = rkEl('button', 'rank-vote-btn', it.voted ? '✓ โหวตแล้ว' : (closed ? '🔒 ปิดโหวต' : '👍 โหวต'));
                btn.type = 'button'; btn.disabled = !!it.voted || closed;
                btn.onclick = (e) => {
                    e.stopPropagation();
                    rankingSubmit({ trackId: it.trackId, title: it.title, artist: it.artist, durationMs: it.durationMs, cover: it.cover, explicit: !!it.explicit });
                };
                card.append(cover, title, artistEl, meta, btn);
                // เพลงที่ผู้ดูแลเพิ่มเอง (manual_) ไม่มีใน Spotify จึงกดเล่นไม่ได้
                if (!String(it.trackId).startsWith('manual_')) card.onclick = () => playTrack(`spotify:track:${it.trackId}`);
                else card.style.cursor = 'default';
                box.appendChild(card);
            });
        }

        async function loadRanking(silent) {
            const box = document.getElementById('ranking-list'); if (!box) return;
            if (!RANKING_API) { rankingNotice(box, 'ยังไม่ได้ตั้งค่า Ranking API — ใส่ URL ของ Apps Script ที่ตัวแปร RANKING_API ใน main.js'); return; }
            if (!rankingTopic) { rankingNotice(box, rankingTopics.length ? 'เลือกหัวข้อด้านบนเพื่อดูอันดับ' : 'ยังไม่มีหัวข้อจัดอันดับ — รอผู้ดูแลสร้างหัวข้อ'); return; }
            const topicId = rankingTopic.topicId;
            if (!silent && !box.children.length) rankingNotice(box, 'กำลังโหลด...');
            try {
                const data = await rankingApi(null, { action: 'list', topic: topicId });
                if (!data.ok) throw new Error(data.error || 'error');
                if (rankingTopic?.topicId !== topicId) return; // ผู้ใช้สลับหัวข้อระหว่างรอ — ทิ้งผลเก่า
                if (data.topic && data.topic.status !== rankingTopic.status) { rankingTopic = data.topic; renderTopicBar(); }
                renderRanking(data.items);
            } catch (e) {
                console.error('Ranking load error:', e);
                if (e.message === 'topic_not_found') { rankingTopic = null; await loadRankingTopics(); if (rankingTopic) return loadRanking(true); rankingNotice(box, 'ยังไม่มีหัวข้อจัดอันดับ — รอผู้ดูแลสร้างหัวข้อ'); return; }
                if (!box.querySelector('.rank-item')) rankingNotice(box, 'โหลดอันดับไม่สำเร็จ ลองกดรีเฟรช');
            }
        }

        // ---------- หัวข้อจัดอันดับ ----------
        const rankingTopicClosed = () => rankingTopic?.status === 'closed';

        async function loadRankingTopics() {
            if (!RANKING_API) return;
            try {
                const data = await rankingApi(null, { action: 'topics' });
                if (!data.ok) throw new Error(data.error || 'error');
                rankingTopics = data.topics || [];
                const saved = localStorage.getItem(RANKING_TOPIC_KEY);
                const byId = id => rankingTopics.find(t => t.topicId === id);
                // ลำดับเลือก: หัวข้อที่ดูอยู่ > หัวข้อที่เคยเลือกไว้ > หัวข้อแรกที่เปิดโหวต > หัวข้อแรก
                rankingTopic = byId(rankingTopic?.topicId) || byId(saved) || rankingTopics.find(t => t.status === 'open') || rankingTopics[0] || null;
                renderTopicBar();
            } catch (e) { console.error('Ranking topics error:', e); }
        }

        function ensureTopicBar() {
            let bar = document.getElementById('ranking-topics'); if (bar) return bar;
            const view = document.getElementById('view-ranking'); if (!view) return null;
            bar = rkEl('div', 'rank-topics'); bar.id = 'ranking-topics';
            const info = rkEl('div', 'rank-topic-info'), cov = rkEl('img', 'rank-topic-cover'); cov.alt = ''; cov.referrerPolicy = 'no-referrer'; cov.onerror = () => cov.classList.add('hidden');
            info.append(cov, rkEl('div', 'rank-topic-desc'));
            bar.append(rkEl('div', 'rank-topic-chips'), info);
            const head = view.querySelector('.rank-header');
            if (head) head.insertAdjacentElement('afterend', bar); else view.prepend(bar);
            return bar;
        }

        function renderTopicBar() {
            const bar = ensureTopicBar(); if (!bar) return;
            const chips = bar.querySelector('.rank-topic-chips'), desc = bar.querySelector('.rank-topic-desc'), cov = bar.querySelector('.rank-topic-cover'), info = bar.querySelector('.rank-topic-info');
            chips.innerHTML = '';
            rankingTopics.forEach(t => {
                const active = t.topicId === rankingTopic?.topicId;
                const b = rkEl('button', 'rank-topic-chip' + (active ? ' active' : '') + (t.status === 'closed' ? ' closed' : ''), (t.status === 'closed' ? '🔒 ' : '') + t.title);
                b.type = 'button'; b.onclick = () => selectRankingTopic(t.topicId);
                chips.appendChild(b);
            });
            const note = rankingTopicClosed() ? 'หัวข้อนี้ปิดโหวตแล้ว' : '';
            desc.textContent = !rankingTopics.length ? 'ยังไม่มีหัวข้อจัดอันดับ — รอผู้ดูแลสร้างหัวข้อ'
                : [rankingTopic?.description, note].filter(Boolean).join(' · ');
            desc.classList.toggle('hidden', !desc.textContent);
            const listTitle = document.getElementById('ranking-list-title'); if (listTitle) listTitle.textContent = rankingTopic ? `อันดับ: ${rankingTopic.title}` : 'อันดับปัจจุบัน';
            const covUrl = rkSafeUrl(rankingTopic?.cover);
            cov.classList.remove('hidden'); if (covUrl) cov.src = covUrl; else cov.removeAttribute('src');
            cov.classList.toggle('hidden', !covUrl);
            info.classList.toggle('hidden', !covUrl && !desc.textContent);
            // ค้นหา/ส่งเพลงได้เฉพาะหัวข้อที่เปิดโหวต
            const canSubmit = !!rankingTopic && !rankingTopicClosed();
            document.querySelector('#view-ranking .rank-search')?.classList.toggle('hidden', !canSubmit);
            if (!canSubmit) renderRankingSearch(null);
        }

        function selectRankingTopic(id) {
            const t = rankingTopics.find(x => x.topicId === id);
            if (!t || t.topicId === rankingTopic?.topicId) return;
            rankingTopic = t;
            try { localStorage.setItem(RANKING_TOPIC_KEY, id); } catch (e) { }
            const input = document.getElementById('ranking-search-input'); if (input) input.value = '';
            renderRankingSearch(null);
            renderTopicBar();
            const box = document.getElementById('ranking-list'); if (box) box.innerHTML = '';
            loadRanking(false);
        }

        async function refreshRankingView(silent) {
            await loadRankingTopics();
            await loadRanking(silent);
        }

        async function rankingSubmit(song) {
            if (rankingBusy) return false;
            if (!rankingTopic) { showToast('⚠️ กรุณาเลือกหัวข้อก่อน', 'warning'); return false; }
            if (rankingTopicClosed()) { showToast('⚠️ หัวข้อนี้ปิดโหวตแล้ว', 'warning'); return false; }
            const token = localStorage.getItem('spotify_access_token');
            if (!token) { showToast('❌ กรุณาเข้าสู่ระบบใหม่', 'error'); return false; }
            rankingBusy = true;
            document.getElementById('view-ranking')?.classList.add('is-busy');
            try {
                const data = await rankingApi({ action: 'submit', token, topicId: rankingTopic.topicId, ...song });
                if (!data.ok) { showToast('❌ ' + (RK_ERRORS[data.error] || 'ส่งเพลงไม่สำเร็จ'), 'error'); return false; }
                if (data.already) showToast('ℹ️ คุณโหวตเพลงนี้ไปแล้ว', 'warning');
                else if (data.created) showToast('🎉 ส่งเพลงเข้าหัวข้อแล้ว!', 'info');
                else showToast(`✅ นับโหวตแล้ว (ตอนนี้ ${data.votes} โหวต)`, 'info');
                await loadRanking(true);
                return true;
            } catch (e) {
                console.error('Ranking submit error:', e);
                showToast('❌ เชื่อมต่อระบบจัดอันดับไม่ได้', 'error');
                return false;
            } finally {
                rankingBusy = false;
                document.getElementById('view-ranking')?.classList.remove('is-busy');
            }
        }

        function renderRankingSearch(results) {
            const box = document.getElementById('ranking-search-results'); if (!box) return;
            box.innerHTML = '';
            if (!results) return;
            const tracks = results.tracks?.items || [];
            if (!tracks.length) { box.appendChild(rkEl('div', 'rank-empty', 'ไม่พบเพลงที่ค้นหา')); return; }
            tracks.forEach(track => {
                const row = rkEl('div', 'track-item');
                const img = rkEl('img'); img.alt = ''; img.src = track.album?.images?.[track.album.images.length > 1 ? 1 : 0]?.url || '';
                const info = rkEl('div', 'track-item-info');
                const trkArtist = rkEl('div', 'track-item-artist'); if (track.explicit) trkArtist.appendChild(rkExplicitBadge()); trkArtist.appendChild(document.createTextNode(track.artists.map(a => a.name).join(', ')));
                info.append(rkEl('div', 'track-item-title', track.name), trkArtist);
                const btn = rkEl('button', 'rank-add-btn', '＋ ส่งเข้าอันดับ'); btn.type = 'button';
                btn.onclick = (e) => { e.stopPropagation(); openRankingModal(track); };
                row.append(img, info, rkEl('div', 'rank-duration', rkFmt(track.duration_ms)), btn);
                row.onclick = () => playTrack(track.uri);
                box.appendChild(row);
            });
        }

        function openRankingModal(track) {
            if (!rankingTopic || rankingTopicClosed()) { showToast('⚠️ หัวข้อนี้ปิดโหวตแล้ว', 'warning'); return; }
            const imgs = track.album?.images || [];
            rankingPick = {
                trackId: track.id,
                title: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                durationMs: track.duration_ms,
                cover: imgs[1]?.url || imgs[0]?.url || '',
                explicit: !!track.explicit
            };
            document.getElementById('rk-cover-preview').src = rankingPick.cover;
            document.getElementById('rk-title').textContent = rankingPick.title;
            const rkArtist = document.getElementById('rk-artist'); rkArtist.textContent = '';
            if (rankingPick.explicit) rkArtist.appendChild(rkExplicitBadge());
            rkArtist.appendChild(document.createTextNode(rankingPick.artist));
            const rkHead = document.getElementById('rk-modal-heading'); if (rkHead) rkHead.textContent = `ส่งเพลงเข้าหัวข้อ: ${rankingTopic.title}`;
            document.getElementById('rk-duration').textContent = `ระยะเวลา ${rkFmt(rankingPick.durationMs)}`;
            overlayOpen('rank');
        }
        function closeRankingModal() { overlayClose('rank'); rankingPick = null; }

        function setupRanking() {
            const input = document.getElementById('ranking-search-input');
            let timer;
            input?.addEventListener('input', () => {
                clearTimeout(timer);
                const q = input.value.trim();
                if (q.length < 2) { renderRankingSearch(null); return; }
                timer = setTimeout(async () => {
                    try {
                        const r = await fetchWebApi(`v1/search?q=${encodeURIComponent(q)}&type=track&limit=8`);
                        if (input.value.trim() === q) renderRankingSearch(r); // กันผลค้นหาเก่าทับผลใหม่
                    } catch (e) { console.error('Ranking search error:', e); showToast('❌ ค้นหาเพลงไม่สำเร็จ', 'error'); }
                }, 400);
            });
            document.getElementById('btn-ranking-refresh')?.addEventListener('click', () => refreshRankingView(false));

            const modal = document.getElementById('ranking-modal');
            modal?.addEventListener('click', (e) => { if (e.target === modal) closeRankingModal(); });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRankingModal(); });
            document.getElementById('rk-cancel')?.addEventListener('click', closeRankingModal);

            const submitBtn = document.getElementById('rk-submit');
            submitBtn?.addEventListener('click', async () => {
                if (!rankingPick || rankingBusy) return;
                submitBtn.disabled = true; const old = submitBtn.textContent; submitBtn.textContent = 'กำลังส่ง...';
                const ok = await rankingSubmit(rankingPick);
                submitBtn.disabled = false; submitBtn.textContent = old;
                if (ok) { closeRankingModal(); if (input) input.value = ''; renderRankingSearch(null); }
            });
        }
        // เข้าหน้า Ranking = โหลดทันที + รีเฟรชอัตโนมัติทุก 30 วินาที / ออกจากหน้า = หยุด
        function startRankingView() {
            refreshRankingView(false);
            clearInterval(rankingTimer);
            rankingTimer = setInterval(() => { if (document.visibilityState === 'visible') refreshRankingView(true); }, RANKING_REFRESH_MS);
        }
        function stopRankingView() { clearInterval(rankingTimer); rankingTimer = null; }

        // ============================================================
        // MAIN APP
        // ============================================================
        let accessToken = null, currentTrackData = null, currentContextTrack = null, currentUser = null;

        async function init() {
            restoreSpotify429Maintenance();
            if (isSpotify429MaintenanceActive()) return;
            // ผูกปุ่ม/เมนูทั้งหมดก่อนเสมอ — ถ้าโหลดข้อมูลพลาดหรือเป็นบัญชี Free หน้าเว็บจะยังกดใช้/ออกจากระบบได้
            setupEventListeners();
            setupContextMenu();
            try {
                accessToken = await handleRedirect();
                if (!accessToken) { showScreen('login-screen'); return; }
                showScreen('app-screen');
                updateTopNavIndicator();
                navInit();

                let profile;
                try { profile = await getUserProfile(); }
                catch (e) {
                    console.error('Profile error:', e);
                    renderUserProfile({ display_name: 'บัญชีของฉัน' }); // ให้มีเมนูสลับบัญชี/ออกจากระบบเสมอ
                    showAccessError(e);
                    return;
                }
                if (profile) { currentUser = profile; renderUserProfile(profile); }
                // Spotify อาจไม่ส่ง `product` มาใน Dev Mode (Feb 2026) จึงถือว่าเป็น Free ก็ต่อเมื่อมีค่าและไม่ใช่ premium
                // ถ้าไม่มีค่า จะลองเริ่ม Player ก่อน แล้วให้ account_error ของ SDK เป็นตัวบอกว่าไม่ใช่ Premium
                const isFree = !!profile?.product && profile.product !== 'premium';

                getRecentlyPlayed().then(d => { if (d) { renderHistory(d, playTrack); renderHeroBanner(d, playTrack); } }).catch(e => console.error('History error:', e));
                loadHomeCollections();
                loadDailyChart();

                if (isFree) { showPremiumRequiredModal(); return; }
                document.getElementById('player-screen').classList.remove('hidden');
                if (await canUseLocalPlayback()) {
                    initSpotifyPlayer(accessToken, handlePlayerStateChange, () => { console.log('Player is ready!'); });
                } else {
                    // เล่นเสียงในหน้านี้เองไม่ได้ (พบมากในเว็บวิวของแอปมือถือ) — ใช้ Spotify Connect ควบคุมอุปกรณ์อื่นแทน
                    useRemotePlaybackFallback();
                }
            } catch (e) {
                console.error('Init error:', e);
                showAccessError(e);
            }
        }

        function setupEventListeners() {
            setupSeekBars();
            setupWakeLock();
            setupRanking();
            updateTopNavIndicator();
            const replayPosterDate = new Date();
            const replayPosterMonth = document.getElementById('replay-entry-month');
            const replayPosterYear = String(replayPosterDate.getFullYear());
            if (replayPosterMonth) replayPosterMonth.textContent = new Intl.DateTimeFormat('th-TH', { month: 'long' }).format(replayPosterDate);
            const replayPosterYearLabel = document.getElementById('replay-entry-year');
            const replayPosterTaglineYear = document.getElementById('replay-entry-tagline-year');
            if (replayPosterYearLabel) replayPosterYearLabel.textContent = `Replay ${replayPosterYear}`;
            if (replayPosterTaglineYear) replayPosterTaglineYear.textContent = replayPosterYear;
            window.addEventListener('resize', updateTopNavIndicator);
            document.getElementById('login-button').addEventListener('click', loginWithSpotify);
            document.querySelectorAll('.nav-item').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); const v = `view-${e.currentTarget.dataset.target}`; navGo(v); showView(v); }));
            document.getElementById('btn-open-replay')?.addEventListener('click', () => {
                navGo('view-stats');
                showView('view-stats');
                loadReplayHistory();
            });
            document.getElementById('btn-view-all-artists')?.addEventListener('click', () => {
                navGo('view-top-artists');
                showView('view-top-artists');
                loadAllTopArtists();
            });
            document.getElementById('btn-top-artists-back')?.addEventListener('click', () => {
                navGo('view-home');
                showView('view-home');
            });
            document.getElementById('btn-replay-back')?.addEventListener('click', () => {
                navGo('view-home');
                showView('view-home');
            });
            document.getElementById('replay-month')?.addEventListener('change', event => {
                replaySelectedMonth = event.currentTarget.value;
                renderReplay();
            });
            document.getElementById('btn-replay-share')?.addEventListener('click', shareReplayImage);

            // Mobile top nav tabs
            document.querySelectorAll('.top-nav-tab').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); const v = `view-${e.currentTarget.dataset.target}`; navGo(v); showView(v); }));

            // Drawer nav items
            document.querySelectorAll('.drawer-nav-item').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); const v = `view-${e.currentTarget.dataset.target}`; navGo(v); showView(v); closeDrawer(); }));

            // Hamburger button — open drawer
            const btnHamburger = document.getElementById('btn-hamburger');
            const drawerOverlay = document.getElementById('drawer-overlay');
            const mobileDrawer = document.getElementById('mobile-drawer');
            function openDrawer() { mobileDrawer?.classList.add('open'); drawerOverlay?.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
            function closeDrawer() { mobileDrawer?.classList.remove('open'); drawerOverlay?.classList.add('hidden'); document.body.style.overflow = ''; }
            btnHamburger?.addEventListener('click', openDrawer);
            drawerOverlay?.addEventListener('click', closeDrawer);

            // Top search button
            document.getElementById('btn-top-search')?.addEventListener('click', (e) => { e.preventDefault(); navGo('view-search'); showView('view-search'); });
            document.getElementById('btn-top-more')?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const accountButton = document.querySelector('#user-profile .user-profile-btn');
                if (accountButton) accountButton.click();
                else openDrawer();
            });

            let searchTimeout;
            let searchRequestId = 0;
            const searchStatus = document.getElementById('search-api-status');
            const searchInput = document.getElementById('search-input');
            const runSpotifySearch = async (query, requestId = ++searchRequestId) => {
                if (searchStatus) searchStatus.textContent = 'กำลังค้นหาใน Spotify...';
                try {
                    const results = await searchSpotify(query);
                    if (requestId !== searchRequestId || searchInput.value.trim() !== query) return;
                    if (searchStatus) searchStatus.textContent = '';
                    renderSearchResults(results, playTrack, handleArtistClick, handleAlbumClick);
                } catch (error) {
                    if (requestId !== searchRequestId || searchInput.value.trim() !== query) return;
                    console.error('Spotify search error:', error);
                    if (searchStatus) {
                        searchStatus.replaceChildren(document.createTextNode(spotifyRequestMessage(error, 'ค้นหา')));
                        const retry = document.createElement('button');
                        retry.type = 'button';
                        retry.className = 'btn-primary';
                        retry.textContent = 'ลองค้นหาอีกครั้ง';
                        retry.addEventListener('click', () => runSpotifySearch(searchInput.value.trim()));
                        searchStatus.appendChild(retry);
                    }
                    renderSearchResults(null, null, null, null);
                }
            };
            searchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                const query = e.target.value.trim();
                searchRequestId++;
                if (query.length > 2) {
                    searchTimeout = setTimeout(() => runSpotifySearch(query, searchRequestId), 500);
                } else {
                    if (searchStatus) searchStatus.textContent = '';
                    renderSearchResults(null, null, null, null);
                }
            });
            document.getElementById('btn-play-pause').addEventListener('click', togglePlay);
            document.getElementById('btn-next').addEventListener('click', nextTrack);
            document.getElementById('btn-prev').addEventListener('click', previousTrack);
            document.getElementById('btn-lyrics-toggle').addEventListener('click', async () => {
                toggleLyricsModal();
                if (window._spotifyPlayer || remote.id) { const state = remote.id ? window._lastState : await window._spotifyPlayer.getCurrentState(); if (state) { const track = state.track_window?.current_track; if (track && _lyricsSetupTrackId !== track.id) { _lyricsSetupTrackId = track.id; currentTrackData = track; setupLyricsComponent(track); } updateLyricsComponent(state.position, state.duration, state.paused); } }
            });
            document.getElementById('btn-close-lyrics').addEventListener('click', () => toggleLyricsModal());
            setupTvShare();
            setupLyricsMoreMenu();
            setupCarMode();
            setupLyricsControlsAutoHide();
            document.getElementById('btn-lyrics-play-pause')?.addEventListener('click', togglePlay);
            document.getElementById('btn-lyrics-next')?.addEventListener('click', nextTrack);
            document.getElementById('btn-lyrics-prev')?.addEventListener('click', previousTrack);
        }

        let artistLoadRequestId = 0;
        async function handleArtistClick(artistId) {
            const requestId = ++artistLoadRequestId;
            try {
                NAV.artistId = artistId; navGo('view-artist', artistId);
                showView('view-artist');
                document.getElementById('artist-header').innerHTML = 'กำลังโหลด...';
                document.getElementById('artist-top-tracks').innerHTML = '';
                document.getElementById('artist-albums').replaceChildren();
                document.getElementById('artist-featured-release').replaceChildren();
                document.getElementById('artist-featured-section').classList.add('hidden');
                document.getElementById('artist-albums-section').classList.add('hidden');
                const artist = await getArtist(artistId);
                if (requestId !== artistLoadRequestId) return;

                // Fetch these independently so if one fails, it doesn't break the whole page
                const [topTracks, albums, isFollowing] = await Promise.all([
                    getArtistTopTracks(artistId, artist.name).catch(e => { if (e?.status !== 429) console.error('Top tracks error:', e.message); return { tracks: [] }; }),
                    getArtistAlbums(artistId).catch(e => { if (e?.status !== 429) console.error('Albums error:', e.message); return { items: [] }; }),
                    checkFollowsArtist(artistId).catch(e => { if (e?.status !== 429) console.error('Follow status error:', e.message); return false; })
                ]);
                if (requestId !== artistLoadRequestId) return;

                let isFollowingState = isFollowing;
                const toggleFollow = async () => {
                    try {
                        if (isFollowingState) { await unfollowArtist(artistId); isFollowingState = false; showToast('เลิกติดตามแล้ว', 'info'); }
                        else { await followArtist(artistId); isFollowingState = true; showToast('✅ ติดตามแล้ว', 'info'); }
                        renderArtistView(artist, topTracks, albums, playTrack, handleAlbumClick, isFollowingState, toggleFollow);
                    } catch (e) {
                        console.error('Toggle follow error:', e.message);
                        if (e.status === 403 && confirm('Spotify ไม่อนุญาตให้ติดตามศิลปินด้วยสิทธิ์ปัจจุบัน\n\nต้องเข้าสู่ระบบใหม่เพื่ออนุญาตสิทธิ์เพิ่ม ต้องการเข้าสู่ระบบใหม่ตอนนี้ไหม?')) { switchAccount(); return; }
                        showToast('❌ ไม่สามารถอัปเดตสถานะติดตามได้', 'error');
                    }
                };

                renderArtistView(artist, topTracks, albums, playTrack, handleAlbumClick, isFollowingState, toggleFollow);
            } catch (err) {
                if (requestId !== artistLoadRequestId) return;
                console.error('Error fetching artist:', err);
                const header = document.getElementById('artist-header');
                header.replaceChildren();
                const message = document.createElement('p');
                message.className = 'empty-hint';
                message.textContent = spotifyRequestMessage(err, 'โหลดข้อมูลศิลปิน');
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'btn-primary';
                retry.textContent = 'ลองโหลดอีกครั้ง';
                retry.addEventListener('click', () => handleArtistClick(artistId));
                header.append(message, retry);
            }
        }

        async function handleAlbumClick(albumId) {
            try {
                NAV.albumId = albumId; navGo('view-album', albumId);
                showView('view-album');
                document.getElementById('album-header').innerHTML = 'กำลังโหลด...';
                document.getElementById('album-tracks').innerHTML = '';

                const album = await getAlbum(albumId);
                const tracksData = await getAlbumTracks(albumId).catch(e => { console.error('Album tracks error:', e.message); return { items: [] }; });

                renderAlbumView(album, tracksData);
            } catch (err) {
                console.error('Error fetching album:', err);
                showToast('❌ ไม่สามารถโหลดข้อมูลอัลบั้มได้', 'error');
                document.getElementById('album-header').innerHTML = '<div style="color:red">เกิดข้อผิดพลาดในการโหลดข้อมูลอัลบั้ม</div>';
            }
        }

        async function handleDeveloperSoundClick(sound) {
            if (Array.isArray(sound?.tracks)) {
                NAV.developerSoundId = sound.id;
                navGo('view-developer-sound', sound.id);
                showView('view-developer-sound');
                renderDeveloperSoundView(sound, sound.tracks, sound.tracks.length);
                return;
            }
            const match = String(sound?.spotifyUri || '').match(/^spotify:(playlist|album):([A-Za-z0-9]{22})$/);
            if (!match) {
                showToast('Spotify URI ของรายการนี้ไม่ถูกต้อง', 'error');
                return;
            }
            NAV.developerSoundId = sound.id;
            navGo('view-developer-sound', sound.id);
            showView('view-developer-sound');
            const header = document.getElementById('developer-sound-header');
            const tracksContainer = document.getElementById('developer-sound-tracks');
            header.replaceChildren(replayCreateText('div', 'home-collection-loading', 'กำลังโหลดรายการ...'));
            tracksContainer.replaceChildren();
            try {
                let tracks = [];
                let trackTotal = 0;
                if (match[1] === 'album') {
                    const [album, tracksData] = await Promise.all([
                        getAlbum(match[2]),
                        getAlbumTracks(match[2])
                    ]);
                    tracks = tracksData?.items || [];
                    trackTotal = album.total_tracks || tracks.length;
                } else {
                    const fields = 'name,uri,description,images,owner(display_name),tracks(items(track(id,name,uri,duration_ms,explicit,artists(name),album(images))),total)';
                    const playlist = await fetchWebApi(`v1/playlists/${match[2]}?market=TH&fields=${encodeURIComponent(fields)}`);
                    tracks = (playlist?.tracks?.items || []).map(item => item.track).filter(Boolean);
                    trackTotal = playlist?.tracks?.total || tracks.length;
                }
                renderDeveloperSoundView(sound, tracks, trackTotal);
            } catch (error) {
                console.error('Developer sound load error:', error);
                header.replaceChildren(replayCreateText('div', 'home-collection-loading', 'โหลดรายการจาก Spotify ไม่สำเร็จ'));
                tracksContainer.replaceChildren();
                showToast('โหลดรายการเพลงจาก Spotify ไม่สำเร็จ', 'error');
            }
        }

        function renderDeveloperSoundView(sound, tracks, trackTotal) {
            const header = document.getElementById('developer-sound-header');
            const tracksContainer = document.getElementById('developer-sound-tracks');
            header.replaceChildren();
            tracksContainer.replaceChildren();

            const hero = document.createElement('section');
            hero.className = 'developer-sound-hero';
            const back = document.createElement('button');
            back.type = 'button';
            back.className = 'replay-back';
            back.textContent = '← หน้าแรก';
            back.addEventListener('click', () => {
                if (history.state?.v === 'view-developer-sound') history.back();
                else { navGo('view-home'); showView('view-home'); }
            });
            let cover;
            if (sound.cover) {
                cover = document.createElement('img');
                cover.src = sound.cover;
                cover.alt = '';
                cover.referrerPolicy = 'no-referrer';
            } else {
                cover = replayCreateText('div', 'developer-sound-cover-placeholder developer-sound-cover', '♫');
            }
            cover.classList.add('developer-sound-cover');
            const details = document.createElement('div');
            details.className = 'developer-sound-details';
            details.append(
                replayCreateText('span', 'developer-sound-kicker', Array.isArray(sound.tracks) ? 'ซาวด์โดนใจที่ผู้พัฒนาคัดสรร' : sound.spotifyUri.startsWith('spotify:album:') ? 'อัลบั้มที่ผู้พัฒนาคัดสรร' : 'เพลย์ลิสต์ที่ผู้พัฒนาคัดสรร'),
                replayCreateText('h1', '', sound.title),
                replayCreateText('p', '', `${trackTotal} เพลง`)
            );
            const play = document.createElement('button');
            play.type = 'button';
            play.className = 'artist-round-btn artist-play-btn';
            play.setAttribute('aria-label', 'เล่นรายการนี้');
            play.title = 'เล่นรายการนี้';
            play.innerHTML = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5.14v13.72L19 12 8 5.14z"/></svg>';
            play.addEventListener('click', () => {
                if (Array.isArray(sound.tracks)) {
                    if (sound.tracks[0]?.uri) playTrackSequence(sound.tracks);
                    else showToast('ยังไม่มีเพลงให้เล่นในรายการนี้', 'warning');
                } else playTrack(undefined, sound.spotifyUri);
            });
            details.appendChild(play);
            if (sound.spotifyUri?.startsWith('spotify:album:')) {
                const shuffle = document.createElement('button');
                shuffle.type = 'button';
                shuffle.className = 'artist-round-btn album-shuffle-btn';
                shuffle.setAttribute('aria-label', 'สุ่มเพลงในอัลบั้ม');
                shuffle.title = 'สุ่มเพลงในอัลบั้ม';
                shuffle.textContent = '🔀';
                shuffle.addEventListener('click', () => playTrackSequence(tracks, undefined, true));
                details.appendChild(shuffle);
            }
            const intro = document.createElement('div');
            intro.className = 'developer-sound-intro';
            intro.append(back, cover, details);
            hero.appendChild(intro);
            header.appendChild(hero);

            if (!tracks.length) {
                tracksContainer.appendChild(replayCreateText('div', 'home-collection-loading', 'ไม่พบเพลงในรายการนี้'));
                return;
            }
            tracks.forEach((track, index) => {
                const row = document.createElement('div');
                row.className = 'track-item';
                const albumCover = track.album?.images?.[0]?.url || track.image || sound.cover || '';
                const image = document.createElement('img');
                image.src = albumCover;
                image.alt = '';
                const info = document.createElement('div');
                info.className = 'track-item-info';
                const trackTitle = track.name || track.title || 'เพลงไม่พร้อมใช้งาน';
                const artistNames = Array.isArray(track.artists) ? track.artists.map(artist => artist.name).join(', ') : track.artist || '';
                info.append(
                    replayCreateText('div', 'track-item-title', `${index + 1}. ${trackTitle}`),
                    replayCreateText('div', 'track-item-artist', artistNames)
                );
                row.append(image, info);
                if (track.uri) {
                    row.appendChild(trackRowActions({ ...track, album: track.album || { images: [{ url: albumCover }] } }));
                    row.addEventListener('click', () => {
                        if (Array.isArray(sound.tracks)) playTrackSequence(sound.tracks, track.uri);
                        else playTrack(track.uri, sound.spotifyUri);
                    });
                } else {
                    row.classList.add('is-unavailable');
                    row.title = 'เพลงนี้ไม่พร้อมเล่น';
                }
                tracksContainer.appendChild(row);
            });
        }

        function setupContextMenu() {
            const menu = document.getElementById('context-menu');
            document.addEventListener('click', (e) => { if (!e.target.closest('#context-menu')) menu.classList.add('hidden'); });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.classList.add('hidden'); });
            window.showTrackContextMenu = (e, track) => { currentContextTrack = track; menu.style.left = `${e.pageX}px`; menu.style.top = `${e.pageY}px`; menu.classList.remove('hidden'); };
            document.getElementById('menu-play-next').addEventListener('click', async () => {
                if (currentContextTrack) { try { await fetchWebApi(`v1/me/player/queue?uri=${currentContextTrack.uri}`, 'POST'); showToast('✅ เพิ่มลงในคิวแล้ว', 'info'); } catch (e) { showToast('❌ ไม่สามารถเพิ่มลงคิวได้', 'error'); } }
                menu.classList.add('hidden');
            });
            document.getElementById('menu-add-playlist').addEventListener('click', async () => {
                if (currentContextTrack) {
                    overlayOpen('playlist');
                    const listContainer = document.getElementById('playlist-list'); listContainer.innerHTML = 'กำลังโหลด...';
                    try {
                        const user = await getUserProfile();
                        const playlists = await fetchWebApi('v1/me/playlists?limit=50');
                        const myPlaylists = playlists.items.filter(p => p.owner.id === user.id);
                        listContainer.innerHTML = '';
                        if (myPlaylists.length === 0) { listContainer.innerHTML = 'ไม่พบเพลย์ลิสต์ของคุณ'; }
                        else { myPlaylists.forEach(p => { const item = document.createElement('div'); item.className = 'playlist-list-item'; item.textContent = p.name; item.onclick = async () => { try { await fetchWebApi(`v1/playlists/${p.id}/tracks?uris=${currentContextTrack.uri}`, 'POST'); showToast(`✅ เพิ่มเพลงลงใน ${p.name} แล้ว`, 'info'); overlayClose('playlist'); } catch (err) { showToast('❌ ไม่สามารถเพิ่มเพลงได้', 'error'); } }; listContainer.appendChild(item); }); }
                    } catch (e) { listContainer.innerHTML = 'เกิดข้อผิดพลาดในการโหลดเพลย์ลิสต์'; }
                }
                menu.classList.add('hidden');
            });
        }

        // ============================================================
        // แชร์ไปหน้าจอ TV (Beta)
        // เว็บนี้เป็นผู้ส่ง: สร้างรหัส 6 หลัก แล้วส่งสถานะเพลง (เพลง, ตำแหน่ง, เล่น/หยุด, สีพื้นหลัง) ไปที่ Apps Script
        // หน้า tv.html บนทีวีดึงสถานะไปแสดงเนื้อเพลง + สีพื้นหลังเหมือนหน้าเนื้อเพลงของเครื่องนี้
        // ============================================================
        const TV_SESSION_KEY = 'rm_tv_session';
        const tvS = { session: null, last: null, info: new Map(), palette: null, seq: 0, rtt: 400, sent: null, timer: null, beat: null, sending: false };
        try { tvS.session = JSON.parse(localStorage.getItem(TV_SESSION_KEY) || 'null'); } catch (e) { }

        // ใช้ /tv เป็น URL หลัก โดย rewrite ไปยังไฟล์หน้าจอ TV ใส่ ?code= เพื่อเชื่อมต่ออัตโนมัติ
        const tvUrl = () => `${location.origin}/tv?code=${tvS.session.code}`;

        function tvRender() {
            const on = !!tvS.session;
            document.querySelectorAll('#btn-tv-share, #btn-tv-share-lyrics').forEach(b => b.classList.toggle('tv-active', on));
            const code = document.getElementById('tv-share-code'); if (!code) return;
            code.textContent = on ? tvS.session.code.replace(/(\d{3})(\d{3})/, '$1 $2') : '------';
            document.getElementById('tv-share-url').textContent = on ? tvUrl() : '';
            code.classList.toggle('hidden', !on);
            document.getElementById('tv-share-start')?.classList.toggle('hidden', on);
            document.getElementById('tv-share-stop').classList.toggle('hidden', !on);
            document.getElementById('tv-share-copy').classList.toggle('hidden', !on);
        }

        function tvClearLocal() {
            tvS.session = null; tvS.sent = null; clearTimeout(tvS.timer); clearInterval(tvS.beat); tvHelloStop(); tvHello = null;
            localStorage.removeItem(TV_SESSION_KEY); tvRender();
        }

        async function tvStart() {
            const status = document.getElementById('tv-share-status');
            const token = localStorage.getItem('spotify_access_token');
            if (!token) { status.textContent = 'กรุณาเข้าสู่ระบบใหม่'; return; }
            status.textContent = 'กำลังสร้างรหัส...';
            try {
                const r = await rankingApi({ action: 'tv_create', token });
                if (!r.ok) throw new Error(r.error || 'error');
                tvS.session = { code: r.code, key: r.key };
                localStorage.setItem(TV_SESSION_KEY, JSON.stringify(tvS.session));
                status.textContent = 'พร้อมแล้ว — กรอกรหัสนี้บนหน้าจอ TV';
                tvRender(); tvBeat();
                const cur = remote.id ? window._lastState : await window._spotifyPlayer?.getCurrentState?.();
                if (cur) tvOnPlayerState(cur, true);
            } catch (e) {
                console.error('TV create error:', e);
                status.textContent = 'สร้างรหัสไม่สำเร็จ (ตรวจว่าตั้งค่า RANKING_API และ Deploy Code.gs ใหม่แล้ว)';
            }
        }

        async function tvStop() {
            const sess = tvS.session; tvClearLocal();
            document.getElementById('tv-share-status').textContent = 'หยุดแชร์แล้ว';
            if (sess) { try { await rankingApi({ action: 'tv_stop', code: sess.code, key: sess.key }); } catch (e) { } }
        }

        function tvBeat() {
            clearInterval(tvS.beat);
            // ส่งซ้ำทุก 15 วินาทีตอนกำลังเล่น เพื่อให้ทีวีปรับเวลาไม่ให้คลาดเคลื่อนสะสม
            tvS.beat = setInterval(() => { if (tvS.session && tvS.last && !tvS.last.paused) tvPushNow(); }, 15000);
        }
        function tvSchedulePush(ms = 300) { clearTimeout(tvS.timer); tvS.timer = setTimeout(tvPushNow, ms); }

        // เรียกทุกครั้งที่ Spotify แจ้งสถานะเปลี่ยน: ส่งเมื่อ เปลี่ยนเพลง / เล่น-หยุด / กรอเวลา เท่านั้น
        function tvOnPlayerState(state, force) {
            if (!tvS.session) return;
            const track = state?.track_window?.current_track; if (!track) return;
            tvS.last = { track, position: state.position, duration: state.duration, paused: state.paused, at: performance.now() };
            const sent = tvS.sent;
            let need = force || !sent || sent.trackId !== track.id || sent.paused !== state.paused;
            if (!need) {
                const expected = sent.paused ? sent.position : sent.position + (performance.now() - sent.at);
                if (Math.abs(expected - state.position) > 1500) need = true;
            }
            if (need) tvSchedulePush(300);
        }

        async function tvPushNow() {
            const sess = tvS.session, L = tvS.last; if (!sess || !L) return;
            if (tvS.sending) { tvSchedulePush(500); return; }
            tvS.sending = true;
            try {
                const t = L.track;
                let info = tvS.info.get(t.id);
                if (!info) {
                    info = { id: t.id, name: t.name, artists: t.artists.map(a => a.name), album: t.album?.name || '', cover: t.album?.images?.[0]?.url || '', durationMs: t.duration_ms || L.duration, explicit: false, isrc: '' };
                    // ISRC ช่วยให้ทีวีจับคู่เนื้อเพลงได้ตรงเวอร์ชัน รอสูงสุด 1.5 วินาที
                    try {
                        const full = await Promise.race([fetchWebApi(`v1/tracks/${t.id}`), new Promise((_, rej) => setTimeout(rej, 1500))]);
                        info.explicit = !!full?.explicit; info.isrc = full?.external_ids?.isrc || '';
                    } catch (e) { }
                    tvS.info.set(t.id, info);
                }
                const pos = L.paused ? L.position : Math.min(L.duration || Infinity, L.position + (performance.now() - L.at));
                const t0 = performance.now();
                const r = await rankingApi({ action: 'tv_push', code: sess.code, key: sess.key, seq: ++tvS.seq, track: info, position: Math.round(pos), paused: L.paused, lagMs: Math.round(tvS.rtt / 2), palette: tvS.palette });
                tvS.rtt = tvS.rtt * .6 + (performance.now() - t0) * .4;
                if (!r.ok) { if (r.error === 'tv_not_found') { tvClearLocal(); showToast('⚠️ หยุดแชร์ TV แล้ว (รหัสหมดอายุ)', 'warning'); } return; }
                if (r.helloPending && !tvHelloTimer) { tvHelloPoll(); if (!tvHelloNotified && !sess.peer) { tvHelloNotified = true; showToast('📺 หน้า /tv ขอเล่นเสียงบนทีวี — เปิดปุ่ม TV เพื่ออนุญาต', 'info'); } }
                tvS.sent = { trackId: t.id, position: pos, paused: L.paused, at: t0 };
            } catch (e) { console.error('TV push error:', e); }
            finally { tvS.sending = false; }
        }

        // ---------- เลือกอุปกรณ์เล่นเสียง (ทีวี ฯลฯ) ----------
        const DEVICE_ICONS = { TV: '📺', CastVideo: '📺', CastAudio: '🔊', Speaker: '🔊', AVR: '🔊', STB: '📺', AudioDongle: '🔊', Computer: '💻', Smartphone: '📱', Tablet: '📱', GameConsole: '🎮', Automobile: '🚗' };
        const DEVICE_LABELS = { TV: 'ทีวี', CastVideo: 'Chromecast / Google TV', CastAudio: 'Chromecast Audio', Speaker: 'ลำโพง', AVR: 'ชุดรับสัญญาณเสียง', STB: 'กล่องรับสัญญาณ', AudioDongle: 'อุปกรณ์เสียง', Computer: 'คอมพิวเตอร์', Smartphone: 'โทรศัพท์', Tablet: 'แท็บเล็ต', GameConsole: 'เครื่องเกม', Automobile: 'รถยนต์' };
        let devicesCache = [];

        function remoteUiRefresh() {
            const label = document.getElementById('tv-now-playing-on');
            if (label) label.textContent = remote.id ? `กำลังเล่นเสียงบน: ${remote.name}` : 'กำลังเล่นเสียงบน: เครื่องนี้';
            renderDevices();
        }

        function renderDevices() {
            const box = document.getElementById('tv-devices'); if (!box) return;
            const activeId = remote.id || deviceId;
            box.innerHTML = '';
            devicesCache.forEach(d => {
                const btn = document.createElement('button'); btn.type = 'button';
                btn.className = 'tv-device' + (d.id === activeId ? ' active' : '');
                const icon = document.createElement('span'); icon.className = 'tv-device-icon'; icon.textContent = DEVICE_ICONS[d.type] || '🎵';
                const info = document.createElement('span'); info.className = 'tv-device-info';
                const name = document.createElement('span'); name.className = 'tv-device-name'; name.textContent = d.id === deviceId ? `${d.name} (เครื่องนี้)` : d.name;
                const type = document.createElement('span'); type.className = 'tv-device-type'; type.textContent = d.id === activeId ? '🔊 กำลังเล่นเสียงที่นี่' : (DEVICE_LABELS[d.type] || d.type);
                info.append(name, type); btn.append(icon, info);
                btn.onclick = () => { if (d.id !== activeId) transferToDevice(d).then(() => setTimeout(loadDevices, 1500)); };
                box.appendChild(btn);
            });
        }

        async function loadDevices() {
            const box = document.getElementById('tv-devices'), hint = document.getElementById('tv-devices-hint'); if (!box) return;
            box.textContent = 'กำลังค้นหาอุปกรณ์...'; hint.textContent = '';
            try {
                const data = await fetchWebApi('v1/me/player/devices');
                const rank = d => d.id === deviceId ? 3 : /TV|Cast|STB/i.test(d.type) ? 0 : 1;
                devicesCache = (data?.devices || []).filter(d => d.id && !d.is_restricted).sort((a, b) => rank(a) - rank(b));
                if (!devicesCache.length) { box.textContent = 'ไม่พบอุปกรณ์'; }
                else renderDevices();
                const hasOther = devicesCache.some(d => d.id !== deviceId);
                hint.textContent = hasOther ? 'แตะอุปกรณ์เพื่อสลับเสียงไปเล่นที่นั่น (ใช้ Spotify Connect ต้องใช้ Premium)' : 'ยังไม่พบทีวี: เปิดแอป Spotify บนทีวี (หรือกด Cast จากแอป Spotify) โดยใช้บัญชีเดียวกันและเครือข่าย Wi-Fi เดียวกัน แล้วกดค้นหาอีกครั้ง';
            } catch (e) {
                console.error('Devices error:', e);
                box.textContent = 'ค้นหาอุปกรณ์ไม่สำเร็จ';
                hint.textContent = e.status === 403 ? 'ต้องเข้าสู่ระบบใหม่เพื่ออนุญาตสิทธิ์ควบคุมการเล่น (ออกจากระบบแล้วเข้าใหม่)' : 'ลองกดค้นหาอีกครั้ง';
            }
            remoteUiRefresh();
        }

        // ---------- เสียงออกบนหน้า /tv ----------
        // หน้า /tv ขออนุญาต -> ผู้ใช้เทียบรหัสยืนยัน 4 หลักแล้วกดอนุญาต -> เข้ารหัสโทเค็นส่งให้ TV (ECDH P-256 + AES-GCM,
        // เซิร์ฟเวอร์เห็นแค่ข้อมูลเข้ารหัส) -> TV เปิดตัวเล่นชื่อ "R Music TV <รหัส>" -> สลับเสียงไปที่นั่น เครื่องนี้จะเงียบ
        const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' };
        const b64e = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
        const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
        let tvHello = null, tvHelloTimer = null, tvHelloNotified = false, tvSwitching = false;

        async function tvSas(pubB64) {
            const h = new Uint8Array(await crypto.subtle.digest('SHA-256', b64d(pubB64)));
            return String((((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0) % 10000).padStart(4, '0');
        }
        function setTvAudioState(text) { const el = document.getElementById('tv-audio-state'); if (el) el.textContent = text || ''; }

        async function tvGrant(peerPubB64) {
            const token = localStorage.getItem('spotify_access_token'), sess = tvS.session;
            if (!token || !sess) return false;
            const peer = await crypto.subtle.importKey('raw', b64d(peerPubB64), ECDH_PARAMS, false, []);
            const eph = await crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveKey']);
            const aes = await crypto.subtle.deriveKey({ name: 'ECDH', public: peer }, eph.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify({ token })));
            const epub = b64e(await crypto.subtle.exportKey('raw', eph.publicKey));
            const r = await rankingApi({ action: 'tv_grant', code: sess.code, key: sess.key, epub, iv: b64e(iv), ct: b64e(ct) });
            return !!r.ok;
        }

        async function tvHelloPoll() {
            const sess = tvS.session; if (!sess) return;
            try {
                const r = await rankingApi({ action: 'tv_hello_get', code: sess.code, key: sess.key });
                if (!r.ok) { if (r.error === 'tv_not_found') tvClearLocal(); return; }
                tvHello = r.hello || null;
                // TV เครื่องเดิมที่เคยอนุญาตในรหัสนี้แล้ว (กุญแจตรงกัน) ไม่ต้องถามซ้ำ
                if (tvHello && tvHello.pub === sess.peer && !tvSwitching) { tvHello = null; await tvGrant(sess.peer); tvSwitchToTvDevice(); }
                renderAudioRequest();
            } catch (e) { console.error('TV hello error:', e); }
        }

        async function renderAudioRequest() {
            const box = document.getElementById('tv-audio-request'); if (!box) return;
            if (!tvHello) { box.classList.add('hidden'); return; }
            document.getElementById('tv-audio-sas').textContent = await tvSas(tvHello.pub);
            box.classList.remove('hidden');
        }

        async function tvAllow() {
            const h = tvHello, sess = tvS.session; if (!h || !sess) return;
            setTvAudioState('กำลังส่งสิทธิ์ให้ TV...');
            try {
                if (!(await tvGrant(h.pub))) throw new Error('grant failed');
                sess.peer = h.pub; localStorage.setItem(TV_SESSION_KEY, JSON.stringify(sess));
                tvHello = null; renderAudioRequest();
                tvSwitchToTvDevice();
            } catch (e) { console.error(e); setTvAudioState('ส่งสิทธิ์ไม่สำเร็จ ลองอีกครั้ง'); }
        }
        async function tvDeny() {
            const sess = tvS.session; if (!sess) return;
            try { await rankingApi({ action: 'tv_deny', code: sess.code, key: sess.key }); } catch (e) { }
            tvHello = null; renderAudioRequest(); setTvAudioState('ไม่อนุญาตแล้ว');
        }

        // รอตัวเล่นบน TV โผล่ในรายการอุปกรณ์ของ Spotify แล้วสลับเสียงไปที่นั่นอัตโนมัติ (เสียงเครื่องนี้จะดับ)
        async function tvSwitchToTvDevice() {
            if (tvSwitching || !tvS.session) return;
            tvSwitching = true;
            const name = `R Music TV ${tvS.session.code}`;
            setTvAudioState('รอ TV เปิดตัวเล่นเสียง...');
            try {
                for (let i = 0; i < 40 && tvS.session; i++) {
                    try {
                        const data = await fetchWebApi('v1/me/player/devices');
                        const dev = data?.devices?.find(d => d.name === name && d.id);
                        if (dev) { await transferToDevice(dev); setTvAudioState('🔊 เสียงออกที่ทีวีแล้ว (เสียงบนเครื่องนี้ดับ)'); loadDevices(); return; }
                    } catch (e) { }
                    await new Promise(r => setTimeout(r, 1500));
                }
                setTvAudioState('ไม่พบตัวเล่นเสียงบน TV — ตรวจว่าเบราว์เซอร์ทีวีเล่นเสียง Spotify ได้ หรือเลือกอุปกรณ์จากรายการด้านบน');
            } finally { tvSwitching = false; }
        }

        function tvHelloStart() { clearInterval(tvHelloTimer); if (!tvS.session) return; tvHelloPoll(); tvHelloTimer = setInterval(tvHelloPoll, 2500); }
        function tvHelloStop() { clearInterval(tvHelloTimer); tvHelloTimer = null; }

        function setupTvShare() {
            const modal = document.getElementById('tv-modal'); if (!modal) return;
            const open = () => { document.getElementById('tv-share-status').textContent = ''; overlayOpen('tv'); tvRender(); loadDevices(); tvHelloStart(); };
            document.getElementById('btn-tv-share')?.addEventListener('click', open);
            document.getElementById('btn-tv-share-lyrics')?.addEventListener('click', open);
            document.getElementById('tv-share-close')?.addEventListener('click', () => overlayClose('tv'));
            modal.addEventListener('click', e => { if (e.target === modal) overlayClose('tv'); });
            document.getElementById('tv-share-start')?.addEventListener('click', async () => { await tvStart(); tvHelloStart(); });
            document.getElementById('tv-audio-allow')?.addEventListener('click', tvAllow);
            document.getElementById('tv-audio-deny')?.addEventListener('click', tvDeny);
            document.getElementById('tv-devices-refresh')?.addEventListener('click', loadDevices);
            document.getElementById('tv-share-stop')?.addEventListener('click', tvStop);
            document.getElementById('tv-share-copy')?.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(tvUrl()); showToast('✅ คัดลอกลิงก์แล้ว', 'info'); } catch (e) { showToast('คัดลอกไม่ได้ กรุณาคัดลอกจากข้อความในหน้าต่าง', 'warning'); }
            });
            tvRender();
            if (tvS.session) { tvBeat(); if (tvS.session.peer) tvGrant(tvS.session.peer).catch(() => { }); } // รีโหลดหน้าแล้วยังแชร์ต่อ + ส่งโทเค็นใหม่ให้ TV ที่เคยอนุญาตไว้
        }

        // ---------- Media Session ----------
        // ส่งชื่อเพลง/ศิลปิน/ปก/ปุ่มควบคุมให้ระบบปฏิบัติการ แสดงที่หน้าจอล็อก, Control Center, แจ้งเตือนสื่อของ Android
        // และ Dynamic Island ของ iPhone (เว็บวาดใน Dynamic Island เองไม่ได้ ต้องผ่านช่องทางนี้เท่านั้น)
        let _mediaSessionReady = false;
        // เสียงของ Spotify SDK เล่นอยู่ใน iframe ของ Spotify เบราว์เซอร์จึงมักไม่แสดง Media Session ของหน้านี้
        // (แถบควบคุมเพลง/หน้าจอล็อกไม่ขึ้น) วิธีแก้คือเล่นเสียง "เงียบ" วนซ้ำในหน้านี้เอง เป็นตัวยึด Media Session
        let _anchorAudio = null;
        function anchorAudio() {
            if (_anchorAudio) return _anchorAudio;
            const rate = 8000, n = rate * 2, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
            const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
            w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
            v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
            w(36, 'data'); v.setUint32(40, n, true); new Uint8Array(buf, 44).fill(128); // 128 = เงียบสนิท (8-bit)
            const a = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
            a.loop = true; a.setAttribute('playsinline', ''); a.preload = 'auto';
            _anchorAudio = a;
            return a;
        }
        function syncAnchorAudio(state) {
            try {
                const a = anchorAudio();
                if (state.paused) a.pause(); else { const p = a.play(); if (p && p.catch) p.catch(() => { }); }
            } catch (e) { }
        }
        function updateMediaSession(state) {
            if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
            const track = state?.track_window?.current_track; if (!track) return;
            syncAnchorAudio(state);
            const artwork = (track.album?.images || []).map(i => ({ src: i.url, sizes: `${i.width || 300}x${i.height || 300}`, type: 'image/jpeg' }));
            navigator.mediaSession.metadata = new MediaMetadata({ title: track.name, artist: track.artists.map(a => a.name).join(', '), album: track.album?.name || '', artwork });
            navigator.mediaSession.playbackState = state.paused ? 'paused' : 'playing';
            try { if (state.duration > 0) navigator.mediaSession.setPositionState({ duration: state.duration / 1000, playbackRate: 1, position: Math.min(state.position, state.duration) / 1000 }); } catch (e) { }
            if (_mediaSessionReady) return;
            _mediaSessionReady = true;
            const on = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { } };
            on('play', playbackResume);
            on('pause', playbackPause);
            on('previoustrack', previousTrack);
            on('nexttrack', nextTrack);
            on('seekto', d => { if (d && typeof d.seekTime === 'number') playbackSeek(Math.round(d.seekTime * 1000)); });
            on('stop', playbackPause);
        }

        let lyricsDebounceTimer = null;
        // เพลงไหน "ตั้งค่าเนื้อเพลงไปแล้ว" (ไม่ว่าจะเจอเนื้อเพลงจริงหรือสรุปว่าไม่มีเนื้อเพลงก็ตาม)
        // เดิมใช้ "container ว่างไหม" เป็นตัวเช็คแทน แต่พอเพลงไม่มีเนื้อเพลง เราตั้งใจปล่อย container ว่างไว้
        // (setLyricsFoundState(false)) ทำให้ทุกครั้งที่ตำแหน่งเพลงขยับ/เลื่อนเวลา (state เปลี่ยน) เข้าใจผิดว่ายังไม่ได้ตั้งค่า
        // แล้วไปค้นหาเนื้อเพลงซ้ำใหม่ทุกรอบ — เปลี่ยนมาจำ id เพลงที่ตั้งค่าไปแล้วแทน ไม่สนว่า container ว่างหรือไม่
        let _lyricsSetupTrackId = null;
        function handlePlayerStateChange(state) {
            if (!state) return;
            setPlayLoading(false);
            window._lastState = state;
            syncSeekFromState(state);
            updatePlayerUI(state);
            updateMediaSession(state);
            notifyCarPlaybackChange(state);
            tvOnPlayerState(state);
            const track = state.track_window.current_track;
            if (track && _lyricsSetupTrackId !== track.id) {
                currentTrackData = track;
                _lyricsSetupTrackId = track.id;
                clearTimeout(lyricsDebounceTimer);
                lyricsDebounceTimer = setTimeout(() => {
                    if (currentTrackData && currentTrackData.id === track.id) {
                        setupLyricsComponent(track);
                    }
                }, 500);
            }
            updateLyricsComponent(state.position, state.duration, state.paused);
        }

        init().catch(e => { console.error(e); showAccessError(e); });

    }

    // ================= โหมดจอ TV (เดิมคือ tv.js) =================
    function runTv() {
        // ============================================================
        // R Music TV (Beta) — หน้าจอรับสำหรับแชร์ไปยัง TV
        // แสดงเนื้อเพลงซิงก์ + สีพื้นหลังแบบเดียวกับหน้าเนื้อเพลงของเว็บเพลเยอร์
        // รับสถานะจากผู้ส่งผ่าน Apps Script (รหัส 6 หลัก) แล้วคำนวณเวลาเพลงเองบนหน้านี้
        // ============================================================
        const TV_API = 'https://script.google.com/macros/s/AKfycbyxZaws0vfMVlzZijyO8ukeYGKd2IOJ3Y5LAOvok3pgRLU2GdOabnoaA3On2UvFz1i1wg/exec'; // ต้องเป็น URL เดียวกับ RANKING_API ใน main.js
        const POLL_MS = 1500;
        const $ = id => document.getElementById(id);

        // ---- โค้ดหาเนื้อเพลงซิงก์: คัดลอกจาก main.js ตรง ๆ เพื่อให้ผลลัพธ์เหมือนกันทุกประการ ----
        // ---------- หาเนื้อเพลงที่ "ซิงก์ตามเวลา" ----------
        // 1) ให้ <am-lyrics> ค้นหาก่อน (ส่งชื่อเพลง/ศิลปิน/อัลบั้ม/ISRC/ความยาว เพื่อให้จับคู่ถูกเวอร์ชัน)
        // 2) ถ้าได้แต่เนื้อเพลงเปล่า ๆ (ไม่มีเวลา) หรือไม่เจอเลย -> ค้นหาเวอร์ชันซิงก์จาก LRCLIB เอง
        //    แล้วแปลงเป็น TTML ส่งให้ <am-lyrics> แสดงผล
        const THAI_COMBINING = /^[\u0E31\u0E33-\u0E3A\u0E47-\u0E4E]+$/; // สระบน/ล่าง วรรณยุกต์ ฯลฯ ที่ต้องติดกับพยัญชนะตัวหน้า
        const THAI_LEADING = /^[\u0E40-\u0E44]+$/; // สระหน้า เ แ โ ไ ใ ที่ต้องติดกับพยัญชนะตัวหลัง
        // วิดเจ็ตรุ่นใหม่ห่อ <span class="char"> ด้วย <span class="char-motion"> (ตัวที่ขยับ/เรืองแสง) จึงต้องไล่หาเพื่อนบ้านที่ระดับ wrapper
        const charUnit = el => (el.parentElement && el.parentElement.classList.contains('char-motion')) ? el.parentElement : el;
        function adjacentChar(span, dir) {
            let u = charUnit(span)[dir];
            while (u) {
                const c = u.classList.contains('char') ? u : u.querySelector('.char');
                if (c && c.style.display !== 'none' && u.style.display !== 'none') return c;
                u = u[dir];
            }
            return null;
        }
        function glueThai(target, text, atStart) {
            target.textContent = atStart ? text + target.textContent : target.textContent + text;
            target.setAttribute('data-glyph', target.textContent); // เลเยอร์เรืองแสง (::after) ใช้ data-glyph วาดซ้ำ ต้องอัปเดตให้ตรงกับข้อความใหม่
            ['width:auto', 'min-width:auto', 'max-width:none', 'overflow:visible', 'white-space:pre'].forEach(d => { const [k, v] = d.split(':'); target.style.setProperty(k, v, 'important'); });
        }
        function hideThai(span) {
            span.textContent = ''; span.style.display = 'none'; span.removeAttribute('data-glow'); span.classList.remove('native-motion');
            const w = charUnit(span); if (w !== span) w.style.display = 'none'; // ซ่อน wrapper ด้วย ไม่งั้นยังเหลือกล่องว่างที่ขยับ/เรืองแสงแยกเอง
        }
        function fixThaiSpans(root) {
            root.querySelectorAll('.char:not(.th-ok)').forEach(span => {
                span.classList.add('th-ok');
                const t = span.textContent; if (!t) return;
                if (THAI_COMBINING.test(t)) { const prev = adjacentChar(span, 'previousElementSibling'); if (prev) { glueThai(prev, t, false); hideThai(span); } }
                else if (THAI_LEADING.test(t)) { const next = adjacentChar(span, 'nextElementSibling'); if (next) { glueThai(next, t, true); hideThai(span); } }
            });
        }

        // CSS ที่ฉีดเข้า shadow DOM ของ <am-lyrics> เพื่อแก้บรรทัดถัดไปเลื่อนหลุดขึ้นไปบนสุด
        //  1) ตำแหน่งบรรทัดที่กำลังร้อง เดิมอยู่ 8-12% จากขอบบน ซึ่งตรงกับโซนที่ถูกมาสก์ให้จางหาย (ดู .lyrics-right) จึงมองไม่เห็น
        //  2) บรรทัดที่มีท่อนร้องประสาน เช่น "(สวัสดี)" จะกางความสูงออกทีหลัง ทำให้ระยะเลื่อนที่คำนวณไว้คลาดเคลื่อน จึงล็อกความสูงให้คงที่
        const LYRICS_SHADOW_CSS = `
.lyrics-syllable span.char { padding-block: .45em !important; margin-block: -.45em !important; }
.lyrics-syllable .char.native-motion[data-glow]::after { padding-block: .45em !important; }
.lyrics-container { --lyrics-scroll-padding-top: 26% !important; }
@media (max-width: 700px) {
  .lyrics-container { --lyrics-scroll-padding-top: 16% !important; }
}
.lyrics-header, .widget-header { display: none !important; }
.lyrics-toolbar, .lyrics-controls, .toolbar, .controls, button, select, input,
a[href*="github.com"] { display: none !important; }
.lyrics-footer > div:not(.songwriters-info) { display: none !important; }
.songwriters-info { display: none !important; }
.background-vocal-container { height: auto !important; transition: none !important; }
.background-vocal-wrap { opacity: .55 !important; transform: none !important; }
.lyrics-line.bg-expanded .background-vocal-wrap { opacity: 1 !important; }
.lyrics-line.bg-expanded.bg-after .main-vocal-container,
.lyrics-line.bg-expanded.bg-before .main-vocal-container { transform: none !important; }
`;

        function mountLyricsEl(container, attrs, track) {
            container.innerHTML = '';
            const el = document.createElement('am-lyrics');
            Object.entries(attrs).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') el.setAttribute(k, String(v)); });
            el.setAttribute('auto-scroll', 'true'); el.setAttribute('interpolate', 'true'); el.setAttribute('font-family', "'Kanit', sans-serif");
            container.appendChild(el);
            const waitForShadow = setInterval(() => {
                if (!el.isConnected) { clearInterval(waitForShadow); return; }
                if (el.shadowRoot) {
                    clearInterval(waitForShadow);
                    const st = document.createElement('style'); st.textContent = LYRICS_SHADOW_CSS; el.shadowRoot.appendChild(st);
                    const syncWriter = () => {
                        fixThaiSpans(el.shadowRoot);
                        const info = el.shadowRoot.querySelector('.songwriters-info');
                        if (!info || !track || $('tv-lyrics-writer-credit').dataset.trackId !== track.id) return;
                        const clone = info.cloneNode(true);
                        clone.querySelector('b')?.remove();
                        const names = clone.textContent.replace(/^\s*(songwriters|แต่งโดย)\s*:\s*/i, '').trim();
                        if (names) {
                            const credit = $('tv-lyrics-writer-credit');
                            credit.dataset.creditText = names;
                            credit.textContent = `แต่งโดย: ${names}`;
                            credit.classList.toggle('hidden', credit.dataset.completed !== 'true');
                        }
                    };
                    syncWriter();
                    new MutationObserver(syncWriter).observe(el.shadowRoot, { childList: true, characterData: true, subtree: true });
                }
            }, 50);
            return el;
        }

        // รอให้ <am-lyrics> โหลดเสร็จ แล้วบอกว่าได้เนื้อเพลงแบบไหน: 'synced' | 'unsynced' | 'none'
        function waitLyricsResult(el, timeoutMs = 12000) {
            return new Promise(resolve => {
                const start = Date.now(); let seenLoading = false;
                const tick = () => {
                    if (!el.isConnected) return resolve('gone');
                    const loading = !!el.isLoading; if (loading) seenLoading = true;
                    const elapsed = Date.now() - start;
                    if ((seenLoading && !loading) || (!loading && elapsed > 3000) || elapsed > timeoutMs) {
                        const ls = el.lyrics;
                        if (!ls || !ls.length) return resolve('none');
                        return resolve(ls.every(l => l.timestamp === 0 && l.endtime === 0) ? 'unsynced' : 'synced');
                    }
                    setTimeout(tick, 300);
                };
                tick();
            });
        }

        async function lrclibJson(path) {
            try { const r = await fetch(`https://lrclib.net/api/${path}`); return r.ok ? await r.json() : null; } catch (e) { return null; }
        }

        // หาเนื้อเพลงซิงก์จาก LRCLIB ลองหลายรูปแบบชื่อ และเลือกเวอร์ชันที่ความยาวใกล้เคียงกับเพลงที่เล่นอยู่ (กันเวลาเพี้ยน)
        async function findSyncedLrc(track) {
            const durSec = Math.round((track.duration_ms || 0) / 1000);
            const artist = track.artists?.[0]?.name || '';
            const album = track.album?.name || '';
            const raw = track.name || '';
            const titles = [...new Set([raw, raw.split(' - ')[0], raw.replace(/\s*[\(\[].*?[\)\]]/g, ''), raw.split(' - ')[0].split(' (')[0]].map(t => t.trim()).filter(Boolean))];
            const seen = new Map();
            const add = list => (Array.isArray(list) ? list : [list]).forEach(r => { if (r && r.syncedLyrics && !seen.has(r.id)) seen.set(r.id, r); });

            for (const t of titles.slice(0, 2)) {
                const p = new URLSearchParams({ track_name: t, artist_name: artist, album_name: album }); if (durSec) p.set('duration', durSec);
                add(await lrclibJson(`get?${p}`));
                if (seen.size) break;
            }
            if (!seen.size) {
                for (const t of titles) {
                    add(await lrclibJson(`search?${new URLSearchParams({ track_name: t, artist_name: artist })}`));
                    if (seen.size) break;
                    add(await lrclibJson(`search?${new URLSearchParams({ q: `${artist} ${t}` })}`));
                    if (seen.size) break;
                }
            }
            const cands = [...seen.values()];
            if (!cands.length) return null;
            if (!durSec) return cands[0];
            const scored = cands.map(r => ({ r, diff: Math.abs((Number(r.duration) || 0) - durSec) })).sort((a, b) => a.diff - b.diff);
            return scored[0].diff <= 5 ? scored[0].r : null; // ห่างเกิน 5 วินาที = คนละเวอร์ชัน เวลาจะเพี้ยน จึงไม่ใช้
        }

        // แปลง LRC ("[mm:ss.xx] ข้อความ") เป็น TTML ระดับบรรทัดที่ <am-lyrics> อ่านได้
        function lrcToTtml(lrc) {
            const rows = [];
            String(lrc).split(/\r?\n/).forEach(line => {
                const text = line.replace(/\[[^\]]*\]/g, '').trim();
                for (const m of line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) rows.push({ t: Number(m[1]) * 60 + parseFloat(m[2]), text });
            });
            rows.sort((a, b) => a.t - b.t);
            const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const ps = [];
            rows.forEach((r, i) => {
                if (!r.text) return;
                const end = rows[i + 1] ? rows[i + 1].t : r.t + 5;
                ps.push(`<p begin="${r.t.toFixed(2)}s" end="${Math.max(end, r.t + 0.5).toFixed(2)}s">${esc(r.text)}</p>`);
            });
            return ps.length ? `<?xml version="1.0" encoding="UTF-8"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>${ps.join('')}</div></body></tt>` : '';
        }



        // ---- อัลกอริทึมดึงสีจากปก: คัดลอกจาก main.js ตรง ๆ ----
        function hslToRgb(h, s, l) { s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]; }
        function rgbToHue(r, g, b) { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0; if (max !== min) { const d = max - min; if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6; else if (max === g) h = ((b - r) / d + 2) / 6; else h = ((r - g) / d + 4) / 6; } return Math.round(h * 360); }
        // ------------------------------------------------------------
        // Palette จากปกอัลบั้ม: ดึงหลายสีจริงๆ ของภาพ แล้วเอาไปใช้เป็นพื้นหลัง
        // ------------------------------------------------------------
        function rgbToHsl(r, g, b) {
            r /= 255; g /= 255; b /= 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
            let h = 0, s = 0;
            if (max !== min) {
                const d = max - min;
                s = l > .5 ? d / (2 - max - min) : d / (max + min);
                if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
                h *= 60;
            }
            return [h, s * 100, l * 100];
        }
        const colorDist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

        // ดึงสีเด่นหลายสีที่ "ต่างกันจริง" จากภาพ (histogram + เลือกสีที่ห่างกัน)
        function extractPalette(imgEl, count = 5) {
            const size = 64;
            const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(imgEl, 0, 0, size, size);
            const data = ctx.getImageData(0, 0, size, size).data; // ถ้าภาพโดน CORS บล็อก จะ throw ตรงนี้
            const bins = new Map();
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] < 128) continue;
                const r = data[i], g = data[i + 1], b = data[i + 2];
                const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
                let e = bins.get(key); if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; bins.set(key, e); }
                e.n++; e.r += r; e.g += g; e.b += b;
            }
            const cands = [...bins.values()].filter(e => e.n >= 6).map(e => {
                const r = e.r / e.n, g = e.g / e.n, b = e.b / e.n;
                const max = Math.max(r, g, b), min = Math.min(r, g, b), sat = max ? (max - min) / max : 0;
                return { r, g, b, n: e.n, sat, score: e.n * (0.5 + sat) };
            }).sort((x, y) => y.score - x.score);
            const picked = [];
            for (const minDist of [60, 40, 24]) {           // ผ่อนเกณฑ์ความต่างสีลงถ้าภาพมีสีน้อย
                for (const c of cands) {
                    if (picked.length >= count) break;
                    if (picked.every(p => colorDist(p, c) > minDist)) picked.push(c);
                }
                if (picked.length >= count) break;
            }
            // สีสดขึ้นก่อน (จะได้ blob ใหญ่ๆ เป็นสีเด่น) สีเทา/ดำไว้ท้าย
            picked.sort((x, y) => ((y.sat > .2) - (x.sat > .2)) || (y.score - x.score));
            return picked;
        }

        // ปรับสีให้ไม่มืด/ไม่จางเกินไปเมื่อใช้เป็นพื้นหลัง แล้วเติมให้ครบ count สี
        function normalizePalette(picked, count = 5) {
            const out = picked.map(c => {
                let [h, s, l] = rgbToHsl(c.r, c.g, c.b);
                if (s > 15) s = Math.min(90, Math.max(40, s * 1.15));
                l = Math.min(62, Math.max(30, l));
                return hslToRgb(h, s, l);
            });
            if (!out.length) out.push(hslToRgb(220, 55, 42));
            const [bh, bs, bl] = rgbToHsl(...out[0]);
            const shifts = [40, -40, 80, -80, 120, -120];
            for (let i = 0; out.length < count; i++) out.push(hslToRgb((bh + shifts[i % shifts.length] + 360) % 360, Math.max(bs, 35), bl));
            return out.slice(0, count);
        }


        // ============================================================
        // ส่วนของ TV
        // ============================================================
        const S = {
            code: '', cur: null, trackId: '', paletteKey: '', serverPalette: null, paletteFromImage: false, lastPaletteSrc: '',
            offset: null, bestRtt: Infinity,            // offset = เวลาเซิร์ฟเวอร์ - performance.now()
            syncMs: Number(localStorage.getItem('tv_sync_ms')) || 0,
            timer: null, lastEl: null, lastSeekAt: 0, lastLyricsAt: 0, durKey: null,
            // เสียงบน TV (Web Playback SDK)
            audioOk: null, priv: null, pub: '', sas: '', helloAt: 0, grantTs: 0, token: '', player: null, deviceId: '',
            local: null, gesture: false, meta: new Map(), loadingId: ''
        };

        const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
        const fmtTime = ms => { const t = Math.max(0, Math.floor(ms / 1000)); const m = Math.floor(t / 60), s = t % 60; return `${m}:${String(s).padStart(2, '0')}`; };

        let statusTimer;
        function showStatus(text, ms = 3500) {
            const el = $('tv-status'); el.textContent = text; el.classList.add('show');
            clearTimeout(statusTimer); if (ms) statusTimer = setTimeout(() => el.classList.remove('show'), ms);
        }

        // สีพื้นหลัง: ใช้ค่าและวิธีเดียวกับ applyPalette ในหน้าเนื้อเพลงของเว็บเพลเยอร์ (บนจอกว้าง)
        function applyPalette(palette) {
            if (!Array.isArray(palette) || !palette.length) return;
            const modal = $('lyrics-modal');
            palette.forEach((c, i) => modal.style.setProperty(`--blob${i + 1}`, rgba(c, i < 3 ? .6 : .5)));
            if (!modal.querySelector('.modal-blobs')) {
                const layer = document.createElement('div'); layer.className = 'modal-blobs';
                layer.innerHTML = [1, 2, 3, 4, 5].map(n => `<div class="blob blob-${n}"></div>`).join('');
                modal.insertBefore(layer, modal.firstChild);
            }
        }

        // ดึงสีจากปกบน TV เองด้วยอัลกอริทึมเดียวกับเครื่องส่ง (ได้สีเหมือนกัน และเปลี่ยนสีทันทีที่เพลงเปลี่ยน)
        function tvExtract(img) {
            const src = img.currentSrc || img.src || '';
            if (!src || src === S.lastPaletteSrc) return;
            S.lastPaletteSrc = src;
            try { applyPalette(normalizePalette(extractPalette(img))); }
            catch (e) {
                if (S.serverPalette) applyPalette(S.serverPalette);
                else { let hash = 0; for (let i = 0; i < src.length; i++) hash = src.charCodeAt(i) + ((hash << 5) - hash); const hue = Math.abs(hash) % 360; applyPalette([0, 45, -45, 90, -90].map(d => hslToRgb((hue + d + 360) % 360, 65, 45))); }
            }
            S.paletteFromImage = true;
        }

        async function setupLyrics(track) {
            const container = $('lyrics-container');
            const writerCredit = $('tv-lyrics-writer-credit');
            writerCredit.dataset.trackId = track.id;
            writerCredit.dataset.completed = 'false';
            writerCredit.dataset.creditText = 'ไม่พบข้อมูลผู้แต่ง';
            writerCredit.textContent = '';
            writerCredit.classList.add('hidden');
            container.innerHTML = '<div class="lyrics-loading"></div>';
            const id = track.id;
            const stale = () => S.trackId !== id;
            const cleanTitle = track.name.split(' - ')[0].split(' (')[0];
            const primaryArtist = track.artists[0] || '';

            const lyricsEl = mountLyricsEl(container, {
                'song-title': cleanTitle, 'song-artist': primaryArtist, 'song-album': track.album, 'song-duration': track.durationMs,
                query: `${cleanTitle} ${primaryArtist}`, isrc: track.isrc
            }, track);
            const result = await waitLyricsResult(lyricsEl);
            if (result === 'synced' || result === 'gone' || stale()) return;

            const found = await findSyncedLrc({ name: track.name, duration_ms: track.durationMs, artists: track.artists.map(name => ({ name })), album: { name: track.album } });
            if (!found || stale() || !container.contains(lyricsEl)) return;
            const ttml = lrcToTtml(found.syncedLyrics);
            if (!ttml) return;
            mountLyricsEl(container, { 'song-title': cleanTitle, 'song-artist': primaryArtist, 'song-duration': track.durationMs, ttml }, track);
        }

        function loadTrack(track) {
            S.trackId = track.id; S.paletteFromImage = false; S.lastPaletteSrc = '';
            const art = $('lyrics-modal-art');
            art.crossOrigin = 'anonymous';
            art.onload = () => tvExtract(art);
            if (track.cover) art.src = track.cover;
            if (art.complete && art.naturalWidth > 0) tvExtract(art);
            const title = $('lyrics-modal-title');
            const inner = document.createElement('span'); inner.className = 'marquee-inner'; inner.textContent = `${track.name}\u00a0\u00a0\u00a0${track.name}`;
            title.replaceChildren(inner); title.classList.remove('is-overflow');
            requestAnimationFrame(() => { if (inner.scrollWidth > title.clientWidth * 2 + 1) title.classList.add('is-overflow'); else inner.textContent = track.name; });
            const artist = $('lyrics-modal-artist'); artist.textContent = '';
            if (track.explicit) { const b = document.createElement('span'); b.className = 'rank-explicit'; b.title = 'เนื้อหาไม่เหมาะสม (Explicit)'; b.textContent = 'E'; artist.appendChild(b); }
            artist.appendChild(document.createTextNode(track.artists.join(', ')));
            document.title = `${track.name} · R Music TV`;
            setupLyrics(track);
        }

        // สถานะจากผู้ส่ง (ผ่านเซิร์ฟเวอร์) — ใช้เมื่อเสียงยังไม่ได้เล่นบน TV เครื่องนี้
        function applyState(st) {
            if (!st || !st.track || !st.track.id) { S.cur = null; return; }
            S.cur = st; S.serverPalette = st.palette && st.palette.length ? st.palette : null;
            if (S.local) return;                                   // กำลังเล่นบน TV เอง: ใช้สถานะจาก SDK แทน
            if (st.track.id !== S.trackId) loadTrack(st.track);
            const pk = JSON.stringify(st.palette || []);
            if (!S.paletteFromImage && pk !== S.paletteKey) { S.paletteKey = pk; applyPalette(st.palette); }
        }

        // ข้อมูลการเล่นปัจจุบัน: ถ้าเสียงเล่นบน TV เครื่องนี้ใช้เวลาจาก SDK (แม่นที่สุด) ไม่ก็คำนวณจากที่ผู้ส่งบอก
        function getPlayback() {
            const l = S.local;
            if (l) {
                const p = l.position + (l.paused ? 0 : performance.now() - l.ts) + S.syncMs;
                return { durationMs: l.duration, paused: l.paused, pos: Math.max(0, Math.min(l.duration || Infinity, p)) };
            }
            const st = S.cur; if (!st) return null;
            let p = st.position + st.lagMs + S.syncMs;
            // ตำแหน่งเพลง = ที่ผู้ส่งบอก + ค่าหน่วงขาส่ง + เวลาที่ผ่านไปตามนาฬิกาเซิร์ฟเวอร์ + ค่าปรับเวลาด้วยมือ (ปุ่มซ้าย/ขวา)
            if (!st.paused && S.offset != null) p += (performance.now() + S.offset) - st.serverTs;
            return { durationMs: st.track.durationMs, paused: st.paused, pos: Math.max(0, Math.min(st.track.durationMs || Infinity, p)) };
        }

        function updateSeek(pb) {
            const bar = document.querySelector('.seek-bar'); if (!bar) return;
            const d = pb.durationMs || 0, pct = d ? Math.min(1, pb.pos / d) : 0;
            bar.value = Math.round(pct * 1000); bar.style.setProperty('--pct', `${pct * 100}%`);
            document.querySelector('.seek-current').textContent = fmtTime(pb.pos);
            document.querySelector('.seek-remaining').textContent = '-' + fmtTime(d - pb.pos);
        }

        function frame(now) {
            const pb = getPlayback();
            if (pb) {
                const writerCredit = $('tv-lyrics-writer-credit');
                if (writerCredit.dataset.trackId === S.trackId && pb.durationMs) {
                    const completed = pb.pos >= pb.durationMs;
                    writerCredit.dataset.completed = String(completed);
                    writerCredit.textContent = `แต่งโดย: ${writerCredit.dataset.creditText}`;
                    writerCredit.classList.toggle('hidden', !completed);
                }
                const el = document.querySelector('#lyrics-container am-lyrics');
                if (el) {
                    const durKey = pb.paused ? -1 : pb.durationMs;
                    if (el !== S.lastEl || S.durKey !== durKey) { S.lastEl = el; S.durKey = durKey; el.setAttribute('duration', durKey); }
                    if (now - S.lastLyricsAt >= 100) {
                        S.lastLyricsAt = now;
                        el.setAttribute('current-time', String(pb.pos));
                    }
                    el.currentTime = pb.pos;
                }
                if (now - S.lastSeekAt > 200) { S.lastSeekAt = now; updateSeek(pb); }
            }
            requestAnimationFrame(frame);
        }

        // ============================================================
        // เสียงบน TV เครื่องนี้ (Spotify Web Playback SDK)
        //  1) TV ส่งกุญแจสาธารณะ (ECDH) ไปขออนุญาต แล้วโชว์รหัสยืนยัน 4 หลักให้เทียบกับหน้าจอเครื่องส่ง
        //  2) เครื่องส่งกดอนุญาต -> เข้ารหัสโทเค็น Spotify ด้วยกุญแจที่ตกลงกัน (เซิร์ฟเวอร์อ่านไม่ได้) ส่งมาที่ TV
        //  3) TV เปิดตัวเล่นชื่อ "R Music TV <รหัส>" เครื่องส่งสลับเสียงมาที่นี่ เสียงเครื่องส่งจะดับ
        // ============================================================
        const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
        const b64e = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
        const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

        function setAudio(text, isError) {
            const el = $('tv-audio'); if (!el) return;
            el.textContent = text || ''; el.classList.toggle('hidden', !text); el.classList.toggle('err', !!isError);
        }

        async function detectAudio() {
            try {
                if (!window.crypto?.subtle || !navigator.requestMediaKeySystemAccess) return false;
                const cfg = [{ initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }] }];
                for (const ks of ['com.widevine.alpha', 'com.apple.fps.1_0']) { try { await navigator.requestMediaKeySystemAccess(ks, cfg); return true; } catch (e) { } }
            } catch (e) { }
            return false;
        }

        async function loadKeyPair() {
            try {
                const saved = JSON.parse(localStorage.getItem('tv_ecdh') || 'null');
                if (saved) return { priv: await crypto.subtle.importKey('jwk', saved.priv, ECDH, true, ['deriveKey']), pub: saved.pub };
            } catch (e) { }
            const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
            const pub = b64e(await crypto.subtle.exportKey('raw', kp.publicKey));
            localStorage.setItem('tv_ecdh', JSON.stringify({ priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub }));
            return { priv: kp.privateKey, pub };
        }

        async function sasOf(pubB64) {
            const h = new Uint8Array(await crypto.subtle.digest('SHA-256', b64d(pubB64)));
            return String((((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0) % 10000).padStart(4, '0');
        }

        async function tvPost(payload) {
            const r = await fetch(TV_API, { method: 'POST', body: JSON.stringify(payload) });
            return r.json();
        }

        // เรียกครั้งแรกหลังเชื่อมต่อสำเร็จ
        async function startAudioHandshake() {
            if (S.audioOk === null) S.audioOk = await detectAudio();
            if (!S.audioOk) { setAudio('เบราว์เซอร์ของ TV เครื่องนี้เล่นเสียงจาก Spotify ไม่ได้ จึงแสดงเฉพาะเนื้อเพลง (ถ้าอยากได้เสียงจากทีวี ให้เลือกทีวีในรายการอุปกรณ์บนเครื่องส่ง)', false); setTimeout(() => setAudio(''), 12000); return; }
            if (!S.priv) { const kp = await loadKeyPair(); S.priv = kp.priv; S.pub = kp.pub; S.sas = await sasOf(kp.pub); }
            await sendHello();
        }

        async function sendHello() {
            if (!S.code || S.token) return;
            S.helloAt = Date.now();
            try { await tvPost({ action: 'tv_hello', code: S.code, pub: S.pub, name: 'R Music TV' }); } catch (e) { }
            if (!S.player) setAudio(`ต้องการให้เสียงออกทางทีวีเครื่องนี้ไหม?  เปิดเว็บเพลเยอร์บนเครื่องส่ง > ปุ่ม TV > กด “อนุญาต”  •  รหัสยืนยัน  ${S.sas}  (ต้องตรงกับที่ขึ้นบนเครื่องส่ง)`);
        }

        async function handleGrant(g) {
            try {
                const epub = await crypto.subtle.importKey('raw', b64d(g.epub), ECDH, false, []);
                const aes = await crypto.subtle.deriveKey({ name: 'ECDH', public: epub }, S.priv, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
                const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(g.iv) }, aes, b64d(g.ct));
                const { token } = JSON.parse(new TextDecoder().decode(pt));
                if (!token) return;
                S.token = token;
                if (!S.player) initPlayer();
            } catch (e) { console.error('Grant error:', e); }
        }

        function initPlayer() {
            setAudio('กำลังเปิดตัวเล่นเสียงบนทีวี...');
            const start = () => {
                const p = new Spotify.Player({ name: `R Music TV ${S.code}`, getOAuthToken: cb => cb(S.token), volume: 1 });
                p.addListener('ready', ({ device_id }) => { S.deviceId = device_id; setAudio(S.gesture ? 'พร้อมเล่นเสียงบนทีวีเครื่องนี้แล้ว — รอเครื่องส่งสลับเสียงมาที่นี่' : 'พร้อมแล้ว — กดปุ่มใดก็ได้บนรีโมตเพื่อเปิดเสียง'); setTimeout(() => { if (!S.local) setAudio(''); }, 15000); });
                p.addListener('not_ready', () => setAudio('ตัวเล่นเสียงบนทีวีออฟไลน์', true));
                p.addListener('player_state_changed', onSdkState);
                p.addListener('autoplay_failed', () => setAudio('เบราว์เซอร์ปิดกั้นการเล่นอัตโนมัติ — กดปุ่มใดก็ได้บนรีโมตเพื่อเปิดเสียง', true));
                p.addListener('authentication_error', () => setAudio('โทเค็น Spotify หมดอายุ — ให้เครื่องส่งเข้าสู่ระบบใหม่ แล้วหน้านี้จะต่ออายุให้เอง', true));
                p.addListener('account_error', () => setAudio('ต้องใช้บัญชี Spotify Premium เพื่อเล่นเสียงบนทีวี', true));
                p.addListener('initialization_error', () => setAudio('เบราว์เซอร์ของ TV เครื่องนี้เล่นเสียงจาก Spotify ไม่ได้ (ยังแสดงเนื้อเพลงได้)', true));
                p.connect(); S.player = p;
            };
            if (window.Spotify) { start(); return; }
            window.onSpotifyWebPlaybackSDKReady = start;
            const sc = document.createElement('script'); sc.src = 'https://sdk.scdn.co/spotify-player.js'; document.head.appendChild(sc);
        }

        async function fetchMeta(id) {
            if (S.meta.has(id)) return S.meta.get(id);
            try {
                const r = await Promise.race([fetch(`https://api.spotify.com/v1/tracks/${id}`, { headers: { Authorization: `Bearer ${S.token}` } }), new Promise((_, rej) => setTimeout(rej, 1500))]);
                const j = await r.json();
                const m = { explicit: !!j.explicit, isrc: j.external_ids?.isrc || '' }; S.meta.set(id, m); return m;
            } catch (e) { return { explicit: false, isrc: '' }; }
        }

        // สถานะจากตัวเล่นบน TV เอง: เวลา/เพลง/เล่น-หยุด แม่นยำ ไม่มีความหน่วงจากเซิร์ฟเวอร์
        async function onSdkState(state) {
            const t = state?.track_window?.current_track;
            if (!t) { S.local = null; return; }
            S.local = { id: t.id, position: state.position, duration: state.duration || t.duration_ms, paused: state.paused, ts: performance.now() };
            if (S.trackId !== t.id && S.loadingId !== t.id) {
                S.loadingId = t.id;
                const m = await fetchMeta(t.id);
                if (S.local && S.local.id === t.id && S.trackId !== t.id) {
                    loadTrack({ id: t.id, name: t.name, artists: t.artists.map(a => a.name), album: t.album?.name || '', cover: t.album?.images?.[0]?.url || '', durationMs: t.duration_ms || state.duration, explicit: m.explicit, isrc: m.isrc });
                }
                S.loadingId = '';
            }
            setAudio('');
        }

        // ---------- เชื่อมต่อ / ดึงสถานะ ----------
        function schedulePoll() { clearTimeout(S.timer); S.timer = setTimeout(poll, document.hidden ? 4000 : POLL_MS); }

        async function poll() {
            if (!S.code) return;
            const t0 = performance.now();
            let data;
            try {
                const r = await fetch(`${TV_API}?${new URLSearchParams({ action: 'tv_get', code: S.code, _: Date.now() })}`);
                data = await r.json();
            } catch (e) { showStatus('เชื่อมต่อไม่ได้ กำลังลองใหม่...', 0); schedulePoll(); return; }
            const t1 = performance.now();
            if (!data.ok) { disconnect('ไม่พบรหัสนี้ หรือผู้ส่งหยุดแชร์แล้ว'); return; }

            // ซิงก์นาฬิกากับเซิร์ฟเวอร์: ให้น้ำหนักตัวอย่างที่ตอบเร็ว (RTT ต่ำ) มากกว่า เพื่อลดอาการเวลากระตุก
            const rtt = t1 - t0, o = data.serverNow - (t0 + t1) / 2;
            if (S.offset == null) { S.offset = o; S.bestRtt = rtt; }
            else { S.offset += (o - S.offset) * (rtt <= S.bestRtt * 1.3 ? .5 : .08); S.bestRtt = Math.min(rtt, S.bestRtt * 1.02); }

            const first = $('tv-connect').classList.contains('hidden') === false;
            $('tv-connect').classList.add('hidden');
            $('lyrics-modal').classList.remove('hidden');
            applyState(data.state);
            if (!data.state && !S.local) showStatus('เชื่อมต่อแล้ว — รอผู้ส่งเล่นเพลง...', 0);
            else if ($('tv-status').textContent.startsWith('เชื่อมต่อแล้ว') || $('tv-status').textContent.startsWith('เชื่อมต่อไม่ได้')) $('tv-status').classList.remove('show');

            // เสียงบน TV
            if (first) startAudioHandshake();
            else if (S.audioOk && S.priv && !S.token && !data.grant && Date.now() - S.helloAt > 240000) sendHello();
            if (data.grant && data.grant.ts !== S.grantTs && S.priv) { S.grantTs = data.grant.ts; handleGrant(data.grant); }
            schedulePoll();
        }

        function connect(code) {
            code = String(code || '').replace(/\D/g, '');
            if (code.length !== 6) { $('tv-connect-msg').textContent = 'กรุณากรอกรหัส 6 หลัก'; return; }
            S.code = code; S.offset = null; S.bestRtt = Infinity; S.trackId = ''; S.paletteKey = ''; S.cur = null; S.local = null; S.token = ''; S.grantTs = 0; S.helloAt = 0;
            try { S.player?.disconnect(); } catch (e) { } S.player = null;
            localStorage.setItem('tv_code', code);
            $('tv-connect-msg').textContent = 'กำลังเชื่อมต่อ...';
            clearTimeout(S.timer); poll();
            requestWakeLock();
        }

        function disconnect(msg) {
            clearTimeout(S.timer); S.code = ''; S.cur = null; S.local = null; S.trackId = '';
            try { S.player?.disconnect(); } catch (e) { } S.player = null; S.token = '';
            setAudio('');
            $('lyrics-modal').classList.add('hidden');
            $('lyrics-container').innerHTML = '';
            $('tv-status').classList.remove('show');
            $('tv-connect').classList.remove('hidden');
            $('tv-connect-msg').textContent = msg || '';
            $('tv-code-input').focus();
        }

        let wakeLock = null;
        async function requestWakeLock() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { } }
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.code) { requestWakeLock(); schedulePoll(); } });

        // ---------- ปุ่มบนหน้าจอ / รีโมต ----------
        $('tv-connect-btn').addEventListener('click', () => connect($('tv-code-input').value));
        $('tv-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') connect($('tv-code-input').value); });
        // การกด/แตะครั้งแรกทำให้เบราว์เซอร์อนุญาตให้เล่นเสียง (นโยบาย autoplay)
        const onGesture = () => { S.gesture = true; try { S.player?.activateElement?.(); } catch (e) { } };
        document.addEventListener('keydown', onGesture, { capture: true });
        document.addEventListener('click', onGesture, { capture: true });
        document.addEventListener('keydown', e => {
            if ($('tv-connect').classList.contains('hidden')) {
                // ปรับเวลาเนื้อเพลงด้วยปุ่มลูกศรซ้าย/ขวา (ครั้งละ 100ms) กรณีเนื้อเพลงเร็ว/ช้ากว่าเสียง
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    S.syncMs += (e.key === 'ArrowRight' ? 100 : -100);
                    localStorage.setItem('tv_sync_ms', String(S.syncMs));
                    showStatus(`ปรับเวลาเนื้อเพลง ${S.syncMs > 0 ? '+' : ''}${S.syncMs} ms  (ซ้าย = ช้าลง / ขวา = เร็วขึ้น)`);
                } else if (e.key === 'Escape') disconnect('');
            }
        });

        // เปิดด้วย ?code=123456 (หรือรหัสที่จำไว้) แล้วเชื่อมต่ออัตโนมัติ
        const initCode = new URLSearchParams(location.search).get('code') || '';
        $('tv-code-input').value = initCode || localStorage.getItem('tv_code') || '';
        requestAnimationFrame(frame);
        if (initCode) connect(initCode); else $('tv-code-input').focus();

    }
})();