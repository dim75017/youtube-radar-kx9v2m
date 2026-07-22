'use strict';

(() => {
  const SC = window.SPOTIFY_SOUNDCHARTS || {};
  const BROWSE = window.SPOTIFY_BROWSE_CATALOGUE || {};
  const discovery = BROWSE.playlist_discovery || SC.playlist_discovery || {};
  const pool = BROWSE.instrumental_pool || SC.instrumental_pool || {};
  const scoring = SC.opportunity_scoring || {};
  const catalogue = BROWSE.discovery_catalogue || SC.discovery_catalogue || {};
  const catalogueCounts = catalogue.counts || {};

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
    discoveredTracks: firstNumber(catalogueCounts.tracks, discovery.editorial_tracks_total),
    discoveredArtistsTotal: firstNumber(catalogueCounts.artists, discovery.editorial_artists_total),
    measuredCatalogueTracks: firstNumber(catalogueCounts.measured_tracks, scoring.measured_target_tracks, pool.measured),
    playlistCatalogueTracks: firstNumber(catalogueCounts.playlist_tracks, discovery.unique_playlist_tracks),
    catalogueOnlyTracks: firstNumber(catalogueCounts.catalogue_tracks),
    verifiedCatalogueTracks: firstNumber(catalogueCounts.verified_tracks),
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
        return `Catalogue vivant : ${format(visible)} pistes disponibles, dont ${format(metrics.measuredCatalogueTracks)} déjà mesurées. Les lignes à enrichir restent consultables ; A&R reste strict et séparé.`;
      }
      return `Living catalogue: ${format(visible)} tracks available, including ${format(metrics.measuredCatalogueTracks)} already measured. Enrichment rows remain browseable; A&R stays strict and separate.`;
    },
    artists() {
      const visible = liveArtists();
      if (isFrench()) {
        return `${format(visible)} artistes et crédits sont consultables dans le catalogue vivant. Les profils incomplets restent non contactables tant qu’ils ne passent pas les garde-fous A&R.`;
      }
      return `${format(visible)} artists and credits are browseable in the living catalogue. Incomplete profiles remain non-contactable until they pass A&R guardrails.`;
    },
    trackResult() {
      return isFrench()
        ? `${format(liveTracks())} pistes disponibles · ${format(metrics.measuredCatalogueTracks)} mesurées`
        : `${format(liveTracks())} tracks available · ${format(metrics.measuredCatalogueTracks)} measured`;
    },
    artistResult() {
      return isFrench()
        ? `${format(liveArtists())} artistes disponibles · enrichissement continu`
        : `${format(liveArtists())} artists available · continuous enrichment`;
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
    const generated = String(BROWSE.generated_at || SC.generated_at || (SC.freshness && SC.freshness.tracks_at) || '').slice(0, 19);
    const html = isFrench()
      ? `<b>Soundcharts · catalogue vivant + A&R strict</b><br>${format(liveTracks())} pistes disponibles · ${format(liveArtists())} artistes/crédits<br>${format(metrics.playlistsScanned)} playlists scannées · ${format(metrics.measuredCatalogueTracks)} pistes mesurées<br>${format(metrics.opportunities)} opportunités A&R strictes${generated ? `<br>Snapshot ${generated.replace('T', ' ')}` : ''}`
      : `<b>Soundcharts · living catalogue + strict A&R</b><br>${format(liveTracks())} tracks available · ${format(liveArtists())} artists/credits<br>${format(metrics.playlistsScanned)} playlists scanned · ${format(metrics.measuredCatalogueTracks)} measured tracks<br>${format(metrics.opportunities)} strict A&R opportunities${generated ? `<br>Snapshot ${generated.replace('T', ' ')}` : ''}`;
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
