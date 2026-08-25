const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function platformBlock(source) {
  const match = source.match(/<div class(?:Name)?="radar-switch"[\s\S]*?<\/div>/);
  assert.ok(match, "missing platform switch");
  return match[0];
}

test("YouTube, Spotify and Socials expose the same centered header order", () => {
  const surfaces = [
    {
      source: read("index.html"),
      hrefs: ["./", "spotify/?app=20260825-dashboard-v1#dashboard", "social/"],
    },
    {
      source: read("spotify/index.html"),
      hrefs: ["../", "./?app=20260825-dashboard-v1#dashboard", "../social/"],
    },
    {
      source: read("social-app/app/SocialOS.tsx"),
      hrefs: ["../", "../spotify/?app=20260825-dashboard-v1#dashboard", "./"],
    },
  ];

  for (const { source, hrefs } of surfaces) {
    const block = platformBlock(source);
    const sidebarEnd = source.indexOf("</aside>");
    assert.match(source, /<header class(?:Name)?="platform-header">/);
    assert.ok(sidebarEnd >= 0, "missing sidebar boundary");
    assert.ok(source.indexOf(block) > sidebarEnd, "platform navigation must live in the page header, not the sidebar");
    const positions = ["YouTube", "Spotify", "Socials"].map((label) =>
      block.indexOf(label),
    );
    assert.ok(positions.every((position) => position >= 0));
    assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
    for (const href of hrefs) {
      assert.match(block, new RegExp(`href=["']${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`));
    }
    assert.equal((block.match(/aria-current=/g) ?? []).length, 1);
    assert.doesNotMatch(block, /target=["']_blank["']/);
    assert.equal((block.match(/<img\b/g) ?? []).length, 3);
  }
});

test("every platform prerenders both destinations for instant switching", () => {
  const youtube = read("index.html");
  const spotify = read("spotify/index.html");
  const socials = read("social-app/preview/index.html");

  assert.match(youtube, /"urls":\["spotify\/\?app=20260825-dashboard-v1#dashboard","social\/"\]/);
  assert.match(spotify, /"urls":\["\.\.\/","\.\.\/social\/"\]/);
  assert.match(socials, /"urls":\["\/youtube-radar-kx9v2m\/","\/youtube-radar-kx9v2m\/spotify\/\?app=20260825-dashboard-v1#dashboard"\]/);
  for (const source of [youtube, spotify, socials]) {
    assert.match(source, /"eagerness":"immediate"/);
  }
});

test("platform headers use the official Spotify mark and a centered three-column layout", () => {
  const youtube = read("assets/platform-youtube.svg");
  const instagram = read("assets/platform-instagram.svg");
  const spotify = read("assets/platform-spotify.svg");
  const socialSpotify = read("social-app/public/platforms/spotify.svg");
  const localSpotifyMark = /(?:assets\/platform-spotify\.svg|platforms\/spotify\.svg)/;
  assert.match(youtube, /fill="#FFFFFF"/);
  assert.match(instagram, /stroke="#FFFFFF"/);
  assert.equal(spotify, socialSpotify, "both published Spotify marks must stay byte-identical");
  const spotifyAssetHash = crypto
    .createHash("sha256")
    .update(spotify.replace(/\r\n/g, "\n").trimEnd())
    .digest("hex");
  assert.equal(
    spotifyAssetHash,
    "ead72f82725038389cca09f439fdb7807640e122500c934f2500c7036bf40dbb",
    "the vendored mark must remain the approved official Spotify asset",
  );
  assert.match(spotify, /viewBox="0 0 236\.05 225\.25"/);
  assert.match(spotify, /m122\.37,3\.31C61\.99\.91,11\.1,47\.91,8\.71,108\.29/);
  assert.match(spotify, /fill:#1ed760/);
  assert.doesNotMatch(spotify, /<(?:circle|script|image)\b|M17\.52 16\.63|\b(?:href|xlink:href)=/);

  for (const sourcePath of ["index.html", "spotify/index.html", "social-app/app/SocialOS.tsx"]) {
    const block = platformBlock(read(sourcePath));
    assert.match(block, localSpotifyMark);
    assert.match(block, /platform-spotify\.svg\?v=20260825-logo-v3|platforms\/spotify\.svg\?v=20260825-logo-v3/);
    assert.match(block, /width="24" height="24"/);
    assert.doesNotMatch(block, /storage\.googleapis\.com\/pr-newsroom/);
  }

  for (const cssPath of [
    "assets/css/dashboard.css",
    "spotify/dashboard.css",
    "social-app/app/globals.css",
  ]) {
    const css = read(cssPath);
    assert.match(css, /\.platform-header\s*\{[\s\S]*?justify-content:\s*center/);
    assert.match(css, /\.platform-header\s*\{[\s\S]*?width:\s*calc\(100% \+ var\(--content-gutter\) \+ var\(--content-gutter\)\)/);
    assert.match(css, /\.radar-switch\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  }

  assert.match(read("assets/css/dashboard.css"), /\.radar-switch a\.sp img\{width:24px;height:24px\}/);
  assert.match(read("spotify/dashboard.css"), /\.radar-switch a\.sp img\{width:24px;height:24px\}/);
  assert.match(read("social-app/app/globals.css"), /\.radar-switch a\.spotify img\s*\{[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;/);
});

test("Social runtime is built into Pages without publishing its source tree", () => {
  const workflow = read(".github/workflows/deploy-pages.yml");
  const config = read("_config.yml");
  const vite = read("social-app/preview/vite.config.ts");
  const preview = read("social-app/preview/main.tsx");

  assert.match(workflow, /\/social-app\//);
  assert.match(workflow, /LOFI_SOCIAL_OUT_DIR:\s*\.\.\/social/);
  assert.match(workflow, /test -f \.\/\_site\/social\/index\.html/);
  assert.match(workflow, /test ! -e \.\/\_site\/social-app/);
  assert.match(config, /- social-app/);
  assert.match(vite, /\/youtube-radar-kx9v2m\/social\//);
  assert.match(preview, /youtube-radar-kx9v2m\/main\/social-app\/data/);
  assert.doesNotMatch(preview, /lofi-social-radar-preview/);
});

test("Social inventory and migrated Instagram frames keep their baselines", () => {
  const video = JSON.parse(read("social-app/data/trends/feed.json"));
  const audio = JSON.parse(read("social-app/data/audio-trends/feed.json"));
  const comments = JSON.parse(read("social-app/data/comment-opportunities/feed.json"));
  const history = JSON.parse(read("social-app/data/public-history.json"));
  const instagramDir = path.join(root, "social-app/public/media/instagram");

  assert.ok(video.trends.length >= 50);
  assert.ok(audio.trends.length >= 50);
  assert.ok(comments.opportunities.length >= 20);
  assert.equal(fs.readdirSync(instagramDir).length, 1676);

  const migrated = history.posts.filter((post) =>
    String(post.thumbnailUrl ?? "").includes(
      "/youtube-radar-kx9v2m/social/media/instagram/",
    ),
  );
  assert.equal(migrated.length, 1676);
  for (const post of migrated) {
    const filename = new URL(post.thumbnailUrl).pathname.split("/").pop();
    assert.ok(filename && fs.existsSync(path.join(instagramDir, filename)));
  }
});

test("migrated Social workflows never publish a separate gh-pages branch", () => {
  const workflowDir = path.join(root, ".github/workflows");
  const workflows = fs
    .readdirSync(workflowDir)
    .filter((name) => name.startsWith("social-") && name.endsWith(".yml"));
  assert.ok(workflows.length >= 8);
  for (const name of workflows) {
    const source = read(`.github/workflows/${name}`);
    assert.match(source, /working-directory:\s*social-app/);
    assert.doesNotMatch(source, /gh-pages|publish-public-preview/);
  }
});

test("Social media never starts audible playback automatically", () => {
  const sourceFiles = [
    "social-app/app/SocialInlinePlayer.tsx",
    "social-app/app/SocialOS.tsx",
    "social-app/app/AudioTrendFeedView.tsx",
    "social-app/app/CommentOpportunitiesView.tsx",
    "social-app/lib/social-inline-player.ts",
    "social-app/lib/social-media.ts",
  ];
  const source = sourceFiles.map(read).join("\n");

  assert.doesNotMatch(source, /autoplay=1/iu);
  assert.doesNotMatch(source, /\bautoPlay\b/u);
  assert.doesNotMatch(source, /allow="[^"]*autoplay/iu);
});
