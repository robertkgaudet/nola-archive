// NOLA Archive — WordPress publisher (noladmc.com)
//
// Creates posts on the live WordPress site via the REST API using an
// application password over HTTPS Basic auth.
//
// The application password lives ONLY in .env (WP_APP_PASSWORD) and is never
// logged, printed, or committed. Errors print status codes and WordPress error
// codes — never the credential.
//
// Usage:
//   node src/wp-publish.js --check          verify auth, print the account
//   node src/wp-publish.js --test           create the private plumbing-test post
//   node src/wp-publish.js --delete <id>    move a post to trash
//   node src/wp-publish.js --delete <id> --force   delete permanently

import 'dotenv/config';

const need = (k) => {
  if (!process.env[k]) { console.error(`Missing env var ${k} — add it to .env`); process.exit(1); }
  return process.env[k];
};

const BASE = need('WP_BASE_URL').replace(/\/+$/, '');
const USER = need('WP_USER');
const PASS = need('WP_APP_PASSWORD'); // spaces are part of the password — do not strip

// WordPress application passwords are shown as 6 space-separated groups of 4.
// The spaces are significant; WP strips them itself on comparison, but sending
// the value verbatim is what the docs specify.
const authHeader = () => 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

async function wp(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/wp-json${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }

  if (!res.ok) {
    const code = json?.code || '(no code)';
    const msg = json?.message || text.slice(0, 200);

    // The signature of a stripped Authorization header: WordPress reports
    // "not logged in" rather than rejecting the credential. If the header were
    // reaching PHP, a bad password would come back as `incorrect_password`.
    if (res.status === 401 && code === 'rest_not_logged_in') {
      throw new Error(
        `401 ${code}: ${msg}\n\n` +
        `  WordPress did not see an Authorization header at all — this is a server\n` +
        `  transport problem, not a wrong password. The origin is not passing\n` +
        `  HTTP_AUTHORIZATION through to PHP (common on Apache/LiteSpeed + CGI/FastCGI).\n` +
        `  Fix in the site's root .htaccess:\n\n` +
        `    <IfModule mod_rewrite.c>\n` +
        `    RewriteEngine On\n` +
        `    RewriteCond %{HTTP:Authorization} ^(.*)\n` +
        `    RewriteRule .* - [e=HTTP_AUTHORIZATION:%1]\n` +
        `    </IfModule>\n`
      );
    }
    throw new Error(`${res.status} ${code}: ${msg}`);
  }
  return json;
}

/** Verify the credential works. Returns the authenticated user. */
export async function whoAmI() {
  return wp('/wp/v2/users/me?context=edit');
}

/**
 * Create a post.
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.slug]
 * @param {string} o.html               post_content
 * @param {string} [o.status]           'private' | 'draft' | 'future' | 'publish'
 * @param {string} [o.date]             ISO 8601; required when status is 'future'
 * @param {number} [o.categoryId]       omit to use the site default category
 * @param {string} [o.metaDescription]  SEOPress meta description
 */
export async function createPost({
  title, slug, html, status = 'draft', date, categoryId, metaDescription
}) {
  if (!title) throw new Error('createPost: title is required');
  if (!html) throw new Error('createPost: html is required');

  const body = { title, content: html, status };
  if (slug) body.slug = slug;
  if (date) body.date = date;
  if (categoryId) body.categories = [categoryId];

  // SEOPress stores its description in post meta. Whether REST accepts it
  // depends on the field being registered with show_in_rest; if it isn't, the
  // post still creates and we report that the description didn't stick rather
  // than failing the publish.
  if (metaDescription) body.meta = { _seopress_titles_desc: metaDescription };

  let post;
  try {
    post = await wp('/wp/v2/posts', { method: 'POST', body });
  } catch (e) {
    if (metaDescription && /meta|_seopress/i.test(e.message)) {
      console.warn('  note: meta description rejected by REST; retrying without it');
      delete body.meta;
      post = await wp('/wp/v2/posts', { method: 'POST', body });
      post._metaDescriptionApplied = false;
    } else {
      throw e;
    }
  }
  return post;
}

/** Trash (default) or permanently delete a post. */
export async function deletePost(id, { force = false } = {}) {
  return wp(`/wp/v2/posts/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' });
}

// ---------- the plumbing-test post ----------
const TEST_TITLE = 'TEST — NOLA DMC Answer Library plumbing check (safe to delete)';
const TEST_HTML = `<h2>Plumbing check — this is a test page</h2>

<p>This page exists only to confirm that the NOLA DMC Answer Library pipeline can create a correctly formatted post on this site. It contains no real content and is safe to delete. Placeholder copy follows so the theme's typography, spacing, and content width can be checked against a realistic block of text rather than a single line.</p>

<p>A second paragraph, so paragraph spacing and line height are visible. If this renders with the same margins and measure as a normal blog post, the post format is correct and the pipeline is writing into the right field. If the text runs full-bleed or the heading above is unstyled, the theme is treating this differently from an editor-authored post and that needs looking at before anything real is published.</p>

<h3>Does this page prove anything about scheduling or public visibility?</h3>

<p>No. This post was created with status <code>private</code>, which means it is visible only to logged-in administrators and never to the public. Nothing has been scheduled and nothing has been published. The next step is a decision, not an automatic rollout.</p>

<p>Ready to talk about your programme? <a href="https://noladmc.com/request-for-a-proposal/">Request a Proposal</a>.</p>`;

// ---------- CLI ----------
const arg = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };

if (process.argv.includes('--check')) {
  const me = await whoAmI();
  console.log(`Authenticated as ${me.name} (id ${me.id}, roles: ${(me.roles || []).join(', ')})`);
  console.log(`  publish_posts: ${!!me.capabilities?.publish_posts}  delete_posts: ${!!me.capabilities?.delete_posts}`);
}

if (process.argv.includes('--test')) {
  const me = await whoAmI(); // fail fast with the useful auth diagnostic
  console.log(`Authenticated as ${me.name} (id ${me.id})`);

  const categoryId = arg('--category') ? Number(arg('--category')) : undefined;
  const post = await createPost({
    title: TEST_TITLE,
    slug: 'test-answer-library-plumbing-check',
    html: TEST_HTML,
    status: 'private',
    categoryId,
    metaDescription: 'Internal plumbing test for the NOLA DMC Answer Library. Not public content.'
  });

  console.log('\n=== TEST POST CREATED ===');
  console.log(`  id      : ${post.id}`);
  console.log(`  status  : ${post.status}`);
  console.log(`  link    : ${post.link}`);
  console.log(`  edit    : ${BASE}/wp-admin/post.php?post=${post.id}&action=edit`);
  console.log(`  category: ${JSON.stringify(post.categories)}`);
  console.log(`\n  delete when done:`);
  console.log(`    node src/wp-publish.js --delete ${post.id}`);
}

if (process.argv.includes('--delete')) {
  const id = arg('--delete');
  if (!id) { console.error('--delete requires a post id'); process.exit(1); }
  const force = process.argv.includes('--force');
  const r = await deletePost(id, { force });
  console.log(force
    ? `Post ${id} permanently deleted.`
    : `Post ${id} moved to trash (status: ${r?.post?.status || r?.status || 'trash'}). Add --force to delete permanently.`);
}
