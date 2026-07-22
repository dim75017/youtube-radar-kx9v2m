'use strict';

(() => {
  const SC = window.SPOTIFY_SOUNDCHARTS || {};
  const discovery = SC.playlist_discovery || {};
  const pool = SC.instrumental_pool || {};
  const scoring = SC.opportunity_scoring || {};

  const firstNumber = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) return number;
    }
    return 0;
  };

  const liveTracks = () => {
    try {
      return typeof R !== 'undefined' && Array.isArray(R)
        ? R.length
        : Array.isArray(SC.tracks) ? SC.tracks.length : 0;
    } catch (_) {
      return Array.isArray(SC.tracks) ? SC.tracks.length : 0;
    }
  };

  const liveArtists = () => {
    try {
      return typeof withTracks !== 'undefined' && Array.isArray(withTracks)
        ? withTracks.length
        : Array.isArray(SC.artists) ? SC.artists.length : 0;
    } catch (_) {
      return Array.isArray(SC.artists) ? SC.artists.length : 0;
    }
  };

  const metrics = {
    measuredTracks: firstNumber(scoring.measured_target_tracks, pool.measured),
    measuredDiscoveries: firstNumber(pool.playlist_discovery_measured),
    insertedTracks: firstNumber(pool.inserted_tracks),
    newPlaylistTracks: firstNumber(discovery.new_playlist_tracks),
    newCatalogueTracks: firstNumber(discovery.new_catalogue_tracks),
    uniquePlaylistTracks: firstNumber(discovery.unique_playlist_tracks),
    unseenPlaylistTracks: firstNumber(discovery.unseen_playlist_tracks),
    playlistsScanned: firstNumber(discovery.playlists_scanned),
    discoveredArtists: firstNumber(discovery.editorial_artists_total),
    artistCredits: firstNumber(discovery.new_artist_credits),
    catalogueArtistsScanned: firstNumber(discovery.catalogue_artists_scanned),
    opportunities: Array.isArray(SC.opportunities)
      ? SC.opportunities.length
      : firstNumber(scoring.opportunities),
  };

  const isFrench = () => (document.documentElement.lang || 'fr').toLowerCase().startsWith('fr');
  const format = value => new Intl.NumberFormat(isFrench() ? 'fr-FR' : 'en-GB').format(firstNumber(value));
  const compact = value => new Intl.NumberFormat(isFrench() ? 'fr-FR' : 'en-GB', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(firstNumber(value));

  const text = {
    tracks() {
      const visible = liveTracks();
      if (isFrench()) {
        return `Scan Soundcharts terminé : ${format(metrics.newPlaylistTracks + metrics.newCatalogueTracks)} nouvelles pistes ajoutées au pool, ${format(metrics.measuredDiscoveries)} découvertes mesurées et ${format(metrics.measuredTracks)} pistes cibles mesurées. La liste ci-dessous reste le catalogue vérifié (${format(visible)} lignes) ; les candidats à valider sont classés dans Opportunités A&R.`;
      }
      return `Soundcharts scan completed: ${format(metrics.newPlaylistTracks + metrics.newCatalogueTracks)} new tracks added to the pool, ${format(metrics.measuredDiscoveries)} discoveries measured and ${format(metrics.measuredTracks)} target tracks measured. The list below remains the verified catalogue (${format(visible)} rows); review candidates are ranked in A&R Opportunities.`;
    },
    artists() {
      const visible = liveArtists();
      if (isFrench()) {
        return `${format(metrics.discoveredArtists)} artistes/crédits structurés découverts via ${format(metrics.playlistsScanned)} playlists ; ${format(metrics.catalogueArtistsScanned)} catalogues artistes ont été parcourus lors de ce cycle. ${format(visible)} profils vérifiés sont affichés ci-dessous.`;
      }
      return `${format(metrics.discoveredArtists)} structured artists/credits discovered across ${format(metrics.playlistsScanned)} playlists; ${format(metrics.catalogueArtistsScanned)} artist catalogues were crawled in this cycle. ${format(visible)} verified profiles are displayed below.`;
    },
    trackResult() {
      return isFrench()
        ? `${format(liveTracks())} pistes vérifiées affichées · ${format(metrics.measuredTracks)} pistes cibles mesurées`
        : `${format(liveTracks())} verified tracks shown · ${format(metrics.measuredTracks)} target tracks measured`;
    },
    artistResult() {
      return isFrench()
        ? `${format(liveArtists())} artistes vérifiés affichés · ${format(metrics.discoveredArtists)} découverts`
        : `${format(liveArtists())} verified artists shown · ${format(metrics.discoveredArtists)} discovered`;
    },
  };

  function updateNavigation() {
    const trackCount = document.getElementById('c-opps');
    if (trackCount) {
      trackCount.textContent = compact(liveTracks());
      trackCount.title = text.trackResult();
    }
    const artistCount = document.getElementById('c-art');
    if (artistCount) {
      artistCount.textContent = compact(liveArtists());
      artistCount.title = text.artistResult();
    }
    const radarCount = document.getElementById('c-radar');
    if (radarCount && metrics.opportunities) {
      radarCount.textContent = compact(metrics.opportunities);
      radarCount.title = isFrench()
        ? `${format(metrics.opportunities)} opportunités A&R recalculées`
        : `${format(metrics.opportunities)} recalculated A&R opportunities`;
    }
  }

  function ensureSummary(kind, message) {
    const pageHead = document.querySelector('#view .page-head');
    const heading = pageHead && pageHead.querySelector('h2');
    if (!pageHead || !heading) return;
    let summary = pageHead.querySelector('.discovery-coverage-summary');
    if (!summary) {
      summary = document.createElement('p');
      summary.className = 'discovery-coverage-summary';
      heading.insertAdjacentElement('afterend', summary);
    }
    summary.dataset.kind = kind;
    if (summary.textContent !== message) summary.textContent = message;
  }

  function removeLegacyDetectedBadges() {
    document.querySelectorAll('#view .badge.new').forEach(badge => {
      const value = (badge.textContent || '').trim().toLowerCase();
      if (value.startsWith('détectée') || value === 'found' || value.startsWith('found ')) badge.remove();
    });
  }

  function updateFooter() {
    const detail = document.getElementById('sync-detail-tr');
    if (!detail) return;
    const generated = String(SC.generated_at || (SC.freshness && SC.freshness.tracks_at) || '').slice(0, 19);
    const html = isFrench()
      ? `<b>Soundcharts · découverte + mesure</b><br>${format(metrics.playlistsScanned)} playlists scannées · ${format(metrics.uniquePlaylistTracks)} pistes uniques<br>${format(metrics.measuredDiscoveries)} découvertes mesurées · ${format(metrics.opportunities)} opportunités${generated ? `<br>Snapshot ${generated.replace('T', ' ')}` : ''}`
      : `<b>Soundcharts · discovery + measurement</b><br>${format(metrics.playlistsScanned)} playlists scanned · ${format(metrics.uniquePlaylistTracks)} unique tracks<br>${format(metrics.measuredDiscoveries)} discoveries measured · ${format(metrics.opportunities)} opportunities${generated ? `<br>Snapshot ${generated.replace('T', ' ')}` : ''}`;
    if (detail.innerHTML !== html) detail.innerHTML = html;
  }

  function updateView() {
    updateNavigation();
    updateFooter();
    const route = location.hash.slice(1);
    const heading = document.querySelector('#view .page-head h2');
    const title = (heading && heading.textContent || '').trim().toLowerCase();

    if (route === 'tracks' || title.includes('toutes les pistes') || title.includes('all tracks')) {
      ensureSummary('tracks', text.tracks());
      const result = document.querySelector('#view .result-count');
      if (result && result.textContent !== text.trackResult()) result.textContent = text.trackResult();
      removeLegacyDetectedBadges();
    } else if (route === 'artists' || title.includes('tous les artistes') || title.includes('all artists')) {
      ensureSummary('artists', text.artists());
      const result = document.querySelector('#view .result-count');
      if (result && result.textContent !== text.artistResult()) result.textContent = text.artistResult();
    }
  }

  const style = document.createElement('style');
  style.textContent = `
    .discovery-coverage-summary{max-width:980px;margin-top:7px;color:var(--muted);font-size:12.5px;line-height:1.55}
    #nav .count[title]{cursor:help}
  `;
  document.head.appendChild(style);

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      updateView();
    });
  };

  const view = document.getElementById('view');
  if (view) new MutationObserver(schedule).observe(view, {childList: true, subtree: true});
  const languageSwitch = document.getElementById('lang-switch');
  if (languageSwitch) languageSwitch.addEventListener('click', () => setTimeout(schedule, 0));
  window.addEventListener('hashchange', schedule);
  schedule();
})();
