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

test("YouTube, Spotify and Social expose the same vertical platform order", () => {
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
    const positions = ["YouTube", "Spotify", "Social"].map((label) =>
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

test("platform selectors use real local logos and a one-column layout", () => {
  const youtube = read("assets/platform-youtube.svg");
  const spotify = read("assets/platform-spotify.svg");
  const instagram = read("assets/platform-instagram.svg");
  assert.match(youtube, /fill="#FFFFFF"/);
  assert.match(spotify, /fill="#1ED760"/);
  assert.match(instagram, /stroke="#FFFFFF"/);

  for (const cssPath of [
    "assets/css/dashboard.css",
    "spotify/dashboard.css",
    "social-app/app/globals.css",
  ]) {
    const css = read(cssPath);
    assert.match(css, /\.radar-switch\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
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
