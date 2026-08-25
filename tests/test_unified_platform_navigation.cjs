const assert = require("node:assert/strict");
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
      hrefs: ["./", "spotify/", "social/"],
    },
    {
      source: read("spotify/index.html"),
      hrefs: ["../", "./", "../social/"],
    },
    {
      source: read("social-app/app/SocialOS.tsx"),
      hrefs: ["../", "../spotify/", "./"],
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

  assert.match(youtube, /"urls":\["spotify\/","social\/"\]/);
  assert.match(spotify, /"urls":\["\.\.\/","\.\.\/social\/"\]/);
  assert.match(socials, /"urls":\["\/youtube-radar-kx9v2m\/","\/youtube-radar-kx9v2m\/spotify\/"\]/);
  for (const source of [youtube, spotify, socials]) {
    assert.match(source, /"eagerness":"immediate"/);
  }
});

test("platform headers use the official Spotify mark and a centered three-column layout", () => {
  const youtube = read("assets/platform-youtube.svg");
  const instagram = read("assets/platform-instagram.svg");
  const officialSpotify = "https://storage.googleapis.com/pr-newsroom-wp/1/2023/05/Spotify_Primary_Logo_RGB_Green.png";
  assert.match(youtube, /fill="#FFFFFF"/);
  assert.match(instagram, /stroke="#FFFFFF"/);

  for (const sourcePath of ["index.html", "spotify/index.html", "social-app/app/SocialOS.tsx"]) {
    const block = platformBlock(read(sourcePath));
    assert.match(block, new RegExp(officialSpotify.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(block, /platform(?:s)?\/spotify\.svg/);
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
    "social-app/app/CommentOpportunitiesView.tsx",
    "social-app/lib/social-inline-player.ts",
    "social-app/lib/social-media.ts",
  ];
  const source = sourceFiles.map(read).join("\n");

  assert.doesNotMatch(source, /autoplay=1/iu);
  assert.doesNotMatch(source, /\bautoPlay\b/u);
  assert.doesNotMatch(source, /allow="[^"]*autoplay/iu);
});
