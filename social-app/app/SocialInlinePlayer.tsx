"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  buildSocialInlineEmbedUrl,
  resolveFreshInstagramPlaybackUrl,
  type SocialInlinePlatform,
} from "../lib/social-inline-player";

type PlaybackStatus = "loading" | "playing" | "blocked";

type YouTubePlayer = {
  destroy: () => void;
  getPlayerState: () => number;
  isMuted: () => boolean;
  pauseVideo: () => void;
  playVideo: () => void;
  setVolume: (volume: number) => void;
  unMute: () => void;
};

type YouTubePlayerEvent = { target: YouTubePlayer };
type YouTubeStateEvent = YouTubePlayerEvent & { data: number };
type YouTubePlayerOptions = {
  events: {
    onAutoplayBlocked: () => void;
    onError: () => void;
    onReady: (event: YouTubePlayerEvent) => void;
    onStateChange: (event: YouTubeStateEvent) => void;
  };
};
type YouTubeNamespace = {
  Player: new (element: string | HTMLElement, options: YouTubePlayerOptions) => YouTubePlayer;
};

declare global {
  interface Window {
    YT?: YouTubeNamespace;
  }
}

let youtubeApiPromise: Promise<YouTubeNamespace> | null = null;

export function SocialInlinePlayer({
  active,
  onClose,
  platform,
  playbackExpiresAt,
  playbackUrl,
  sourceUrl,
  title,
}: {
  active: boolean;
  onClose: () => void;
  platform: SocialInlinePlatform;
  playbackExpiresAt?: string | null;
  playbackUrl?: string | null;
  sourceUrl: string;
  title: string;
}) {
  const rawId = useId();
  const frameId = `social-inline-${rawId.replace(/[^A-Za-z0-9_-]/gu, "")}`;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const youtubePlayerRef = useRef<YouTubePlayer | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const hostOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const [status, setStatus] = useState<PlaybackStatus>("loading");
  const [failedPlaybackUrl, setFailedPlaybackUrl] = useState<string | null>(null);

  const embedUrl = useMemo(
    () => buildSocialInlineEmbedUrl(platform, sourceUrl, hostOrigin),
    [hostOrigin, platform, sourceUrl],
  );
  const instagramPlaybackUrl = platform === "instagram"
    ? resolveFreshInstagramPlaybackUrl(playbackUrl, playbackExpiresAt)
    : null;
  const useInstagramVideo = Boolean(instagramPlaybackUrl) &&
    instagramPlaybackUrl !== failedPlaybackUrl;

  const clearFallbackTimer = useCallback(() => {
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  const armFallbackTimer = useCallback(() => {
    clearFallbackTimer();
    if (platform !== "tiktok" && platform !== "youtube") return;
    fallbackTimerRef.current = window.setTimeout(() => {
      setStatus((current) => current === "playing" ? current : "blocked");
    }, 7_000);
  }, [clearFallbackTimer, platform]);

  const requestTikTokPlayback = useCallback(() => {
    const playerWindow = iframeRef.current?.contentWindow;
    if (!playerWindow) return;
    setStatus("loading");
    armFallbackTimer();
    playerWindow.postMessage(
      { type: "unMute", value: undefined, "x-tiktok-player": true },
      "https://www.tiktok.com",
    );
    playerWindow.postMessage(
      { type: "play", value: undefined, "x-tiktok-player": true },
      "https://www.tiktok.com",
    );
  }, [armFallbackTimer]);

  const requestYouTubePlayback = useCallback(() => {
    const player = youtubePlayerRef.current;
    if (!player) {
      setStatus("blocked");
      return;
    }
    setStatus("loading");
    armFallbackTimer();
    try {
      player.unMute();
      player.setVolume(100);
      player.playVideo();
    } catch {
      setStatus("blocked");
    }
  }, [armFallbackTimer]);

  const requestInstagramPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    video.volume = 1;
    setStatus("loading");
    void video.play()
      .then(() => setStatus("playing"))
      .catch(() => setStatus("blocked"));
  }, []);

  useEffect(() => {
    if (!active || !useInstagramVideo) return;
    const video = videoRef.current;
    return () => video?.pause();
  }, [active, instagramPlaybackUrl, useInstagramVideo]);

  useEffect(() => {
    if (!active) return;
    armFallbackTimer();
    return clearFallbackTimer;
  }, [active, armFallbackTimer, clearFallbackTimer, platform]);

  useEffect(() => {
    if (!active || platform !== "tiktok") return;
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== "https://www.tiktok.com" ||
        event.source !== iframeRef.current?.contentWindow ||
        !event.data ||
        typeof event.data !== "object" ||
        event.data["x-tiktok-player"] !== true
      ) return;

      if (event.data.type === "onStateChange" && event.data.value === 1) {
        clearFallbackTimer();
        setStatus("playing");
      } else if (event.data.type === "onMute" && event.data.value === true) {
        setStatus("blocked");
      } else if (
        event.data.type === "onPlayerError" ||
        (event.data.type === "onError" && event.data.value === 3002)
      ) {
        clearFallbackTimer();
        setStatus("blocked");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [active, clearFallbackTimer, platform, requestTikTokPlayback]);

  useEffect(() => {
    if (!active || platform !== "youtube" || !embedUrl) return;
    let cancelled = false;
    let player: YouTubePlayer | null = null;

    void loadYouTubeApi()
      .then((youtube) => {
        if (cancelled) return;
        player = new youtube.Player(frameId, {
          events: {
            onAutoplayBlocked: () => {
              clearFallbackTimer();
              setStatus("blocked");
            },
            onError: () => {
              clearFallbackTimer();
              setStatus("blocked");
            },
            onReady: (event) => {
              youtubePlayerRef.current = event.target;
            },
            onStateChange: (event) => {
              if (event.data !== 1) return;
              try {
                clearFallbackTimer();
                setStatus("playing");
              } catch {
                clearFallbackTimer();
                setStatus("blocked");
              }
            },
          },
        });
        youtubePlayerRef.current = player;
      })
      .catch(() => {
        if (!cancelled) setStatus("blocked");
      });

    return () => {
      cancelled = true;
      clearFallbackTimer();
      youtubePlayerRef.current = null;
      try {
        player?.pauseVideo();
      } catch {
        // Unmounting the iframe is enough to stop a player that is already gone.
      }
    };
  }, [active, clearFallbackTimer, embedUrl, frameId, platform, requestYouTubePlayback]);

  useEffect(() => {
    if (!active) return;
    const pauseWhenHidden = () => {
      if (document.visibilityState !== "hidden") return;
      if (platform === "youtube") {
        try {
          youtubePlayerRef.current?.pauseVideo();
        } catch {
          // The iframe may have been removed during navigation.
        }
      } else if (platform === "tiktok") {
        iframeRef.current?.contentWindow?.postMessage(
          { type: "pause", value: undefined, "x-tiktok-player": true },
          "https://www.tiktok.com",
        );
      } else if (platform === "instagram") {
        videoRef.current?.pause();
      }
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, [active, platform]);

  if (!active) return null;

  if (!embedUrl) {
    return (
      <div className="inline-video-frame social-inline-player-frame is-unavailable" role="status">
        <p>Lecture inline indisponible pour cette publication.</p>
        <button className="inline-player-close" type="button" aria-label="Fermer le lecteur" onClick={onClose}>×</button>
      </div>
    );
  }


  if (platform === "instagram" && useInstagramVideo && instagramPlaybackUrl) {
    return (
      <div className={`inline-video-frame social-inline-player-frame is-direct-video status-${status}`}>
        <video
          ref={videoRef}
          src={instagramPlaybackUrl}
          title={title}
          controls
          playsInline
          preload="metadata"
          muted={false}
          onPlaying={() => setStatus("playing")}
          onError={() => {
            setStatus("blocked");
            setFailedPlaybackUrl(instagramPlaybackUrl);
          }}
        />
        {status === "blocked" ? (
          <button
            className="inline-player-sound-fallback"
            type="button"
            onClick={requestInstagramPlayback}
          >
            🔊 Lire avec le son
          </button>
        ) : null}
        <button className="inline-player-close" type="button" aria-label="Fermer le lecteur" onClick={onClose}>×</button>
      </div>
    );
  }

  if (platform === "instagram") {
    return (
      <div className="inline-video-frame social-inline-player-frame is-instagram-preview-only" role="status">
        <iframe
          id={frameId}
          ref={iframeRef}
          src={embedUrl}
          title={`${title} · aperçu indisponible`}
          aria-hidden="true"
          tabIndex={-1}
          referrerPolicy="strict-origin-when-cross-origin"
          loading="eager"
        />
        <div className="inline-instagram-refresh-message">
          <b>Vidéo momentanément indisponible</b>
          <span>Le lien de lecture sera renouvelé au prochain relevé.</span>
        </div>
        <button className="inline-player-close" type="button" aria-label="Fermer le lecteur" onClick={onClose}>×</button>
      </div>
    );
  }

  return (
    <div className={`inline-video-frame social-inline-player-frame status-${status}`}>
      <iframe
        id={frameId}
        ref={iframeRef}
        src={embedUrl}
        title={title}
        allow="encrypted-media; picture-in-picture; fullscreen"
        referrerPolicy="strict-origin-when-cross-origin"
        loading="lazy"
        allowFullScreen
      />
      {status === "blocked" && (platform === "tiktok" || platform === "youtube") ? (
        <button
          className="inline-player-sound-fallback"
          type="button"
          onClick={platform === "tiktok" ? requestTikTokPlayback : requestYouTubePlayback}
        >
          🔊 Activer le son
        </button>
      ) : null}
      <button className="inline-player-close" type="button" aria-label="Fermer le lecteur" onClick={onClose}>×</button>
    </div>
  );
}

function loadYouTubeApi() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("YouTube IFrame API unavailable during server rendering."));
  }
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;

  youtubeApiPromise = new Promise<YouTubeNamespace>((resolve, reject) => {
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => reject(new Error("YouTube IFrame API failed to load."));
      document.head.appendChild(script);
    }

    const startedAt = Date.now();
    const waitUntilReady = () => {
      if (window.YT?.Player) {
        resolve(window.YT);
      } else if (Date.now() - startedAt >= 10_000) {
        reject(new Error("YouTube IFrame API timed out."));
      } else {
        window.setTimeout(waitUntilReady, 50);
      }
    };
    waitUntilReady();
  });

  return youtubeApiPromise;
}
