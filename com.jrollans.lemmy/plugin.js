// com.jrollans.lemmy
//
// Tapestry 2.0 connector for Lemmy (https://join-lemmy.org).
//
// Features:
//   - Logs in with username/password and caches the JWT in local storage.
//   - Loads the "Subscribed" post feed (all communities the account follows).
//   - Upvote, downvote, and remove-vote actions on each post.
//   - Browsing comments: a "thread" context action on each post loads the
//     whole comment tree as a depth-first list of items.
//   - Voting on comments, and replying to comments, using the same action ids
//     as posts. Items carry metadata.kind ("post" or "comment") so
//     performAction knows which Lemmy endpoint to call.
//   - Commenting through Tapestry's composer: "comment" (on a post) and
//     "reply" (on a comment) open a Draft, and "send_comment" posts it.
//
// Tapestry 2.0 conventions used here:
//   - load(), verify(), and performAction() RETURN their results and THROW
//     Errors to report failures. processError/processVerification/
//     actionComplete do not exist for 2.0 connectors.
//   - Networking uses fetch(); sendRequest() is not available.
//   - item.actions is a Set managed with add()/delete(). Data that actions
//     need is stored as strings in item.metadata.
//   - performAction(actionId, target, actionValue): target is an Item for
//     "items" actions and a Draft for "drafts" actions.
//
// Assumption to verify in Loom: Lemmy API v3 (/api/v3/...) is used. Instances
// running Lemmy releases that dropped v3 will need the path changed.

// Number of posts requested per page. Lemmy caps this at 50.
const PAGE_SIZE = 50;

// Avatar used for any account (post author, comment author, or the logged-in
// account) that has no profile image. This is the same image as the
// connector icon in plugin-config.json; keep the two in sync.
const DEFAULT_AVATAR = "https://lemmy.world/pictrs/image/32afad92-0ff9-4253-9135-ab9832111af6.png";

// Local storage key for the cached JWT.
const JWT_KEY = "jwt";

// Lemmy's maximum comment length, used for the composer's character counter.
const COMMENT_MAX_LENGTH = 10000;

// Comments requested per page, and the most pages fetched for one thread
// (so a thread loads at most COMMENT_PAGE_SIZE * MAX_COMMENT_PAGES comments).
const COMMENT_PAGE_SIZE = 50;
const MAX_COMMENT_PAGES = 10;

// Deepest reply level requested from Lemmy.
const MAX_COMMENT_DEPTH = 10;

// ---------------------------------------------------------------------------
// Helpers: URLs, headers
// ---------------------------------------------------------------------------

/**
 * Returns the instance base URL with any trailing slashes removed, so that
 * paths like "/api/v3/post/list" can be appended safely.
 */
function baseUrl() {
	return site.replace(/\/+$/, "");
}

/**
 * Builds the extra HTTP headers for an authenticated Lemmy request.
 * Lemmy authenticates API calls with "Authorization: Bearer <jwt>". Tapestry
 * only injects its own Authorization header when it manages credentials, which
 * this connector does not (Lemmy's login response uses "jwt", not the
 * "accessJwt" key Tapestry's JWT flow expects), so the header is set here.
 */
function authHeaders(jwt) {
	return { "Authorization": "Bearer " + jwt };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Logs in with the username and password variables from ui-config.json.
 * On success the returned JWT is stored in local storage and returned.
 * Throws if the credentials are rejected or no token comes back (for example
 * when the account requires 2FA, which is not supported).
 */
async function login() {
	const json = await fetch.post(baseUrl() + "/api/v3/user/login", {
		json: { username_or_email: username, password: password }
	}).json();
	if (!json.jwt) {
		throw new Error("Lemmy login did not return a token. Check credentials; accounts with 2FA are not supported.");
	}
	setItem(JWT_KEY, json.jwt);
	return json.jwt;
}

/**
 * Returns a usable JWT: the cached one if present, otherwise a fresh login.
 */
async function getJwt() {
	const cached = getItem(JWT_KEY);
	if (cached) {
		return cached;
	}
	return await login();
}

/**
 * Runs an authenticated Lemmy request and returns the parsed JSON.
 *
 * `makeRequest` is a function taking a JWT and returning a pending fetch()
 * request. If it fails with HTTP 400 or 401 (Lemmy reports an expired or
 * invalid token as "not_logged_in", typically with status 400), the cached
 * token is discarded, a fresh login is performed, and the request is retried
 * exactly once. Any other failure, or a second failure, is thrown.
 */
async function authed(makeRequest) {
	let jwt = await getJwt();
	try {
		return await makeRequest(jwt).json();
	}
	catch (error) {
		const retryable = (error.name === "HTTPError") && (error.status === 400 || error.status === 401);
		if (!retryable) {
			throw error;
		}
		console.log("Request failed with " + error.status + ", logging in again and retrying once");
		setItem(JWT_KEY, null);
		jwt = await login();
		return await makeRequest(jwt).json();
	}
}

// ---------------------------------------------------------------------------
// Content conversion
// ---------------------------------------------------------------------------

/**
 * Escapes the characters that are significant in HTML so that user-supplied
 * text can be embedded in the item body safely.
 */
function escapeHtml(text) {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Converts Lemmy's Markdown into the HTML Tapestry displays.
 *
 * Tapestry's timeline preview supports only a small set of tags (p, strong,
 * em, s, a, img, blockquote, br), while the detail view is a full web view.
 * This converter sticks to those tags wherever possible so formatting shows in
 * BOTH views. Supported Markdown:
 *
 *   - **bold**, __bold__, *italic*, _italic_, ***bold italic***, ~~strike~~
 *   - [label](https://...) links
 *   - > block quotes (consecutive lines form one quote; nesting is flattened)
 *   - # headings (any level), shown as a bold paragraph
 *   - bullet lists (- * +), shown as lines starting with a bullet character;
 *     numbered lists are kept as typed
 *   - --- horizontal rules (detail view only, per Tapestry)
 *   - `inline code` and ``` fenced code blocks (detail view only)
 *   - Lemmy mentions: !community@instance and @user@instance become links
 *   - Lemmy spoiler fences (::: spoiler title ... :::), shown as a bold
 *     "Spoiler:" heading with the contents following it
 *
 * All user text is HTML-escaped first, so post content cannot inject markup.
 * Code and links are swapped for private placeholder tokens while formatting
 * runs, so characters inside them (like the underscores in a URL) are never
 * mistaken for emphasis, and the real HTML is restored at the end.
 * Markdown images are handled separately by extractMarkdownImages().
 */
function markdownToHtml(markdown) {
	if (!markdown) {
		return "";
	}
	let text = markdown.replace(/\r\n?/g, "\n");

	// Placeholder storage: protect() stashes finished HTML and returns a token.
	let stash = [];
	function protect(html) {
		stash.push(html);
		return "\uE000" + (stash.length - 1) + "\uE001";
	}

	// Code first, so nothing inside it is treated as Markdown.
	text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, function (match, code) {
		return "\n\n" + protect("<pre><code>" + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>") + "\n\n";
	});
	text = text.replace(/`([^`\n]+)`/g, function (match, code) {
		return protect("<code>" + escapeHtml(code) + "</code>");
	});

	// Formats one run of text (no block structure): escape, then links,
	// mentions, and emphasis.
	function inline(raw) {
		let h = escapeHtml(raw);
		h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (match, label, url) {
			return protect('<a href="' + url + '">') + label + protect("</a>");
		});
		h = h.replace(/(^|[\s(])!([A-Za-z0-9_]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, function (match, lead, name, host) {
			return lead + protect('<a href="https://' + host + "/c/" + name + '">!' + name + "@" + host + "</a>");
		});
		h = h.replace(/(^|[\s(])@([A-Za-z0-9_.-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, function (match, lead, name, host) {
			return lead + protect('<a href="https://' + host + "/u/" + name + '">@' + name + "@" + host + "</a>");
		});
		h = h.replace(/\*\*\*([^*\n]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
		h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
		h = h.replace(/__(.+?)__/g, "<strong>$1</strong>");
		h = h.replace(/~~(.+?)~~/g, "<s>$1</s>");
		h = h.replace(/\*(?![\s*])([^*\n]+?)\*/g, "<em>$1</em>");
		// Underscore italics must not fire inside words (snake_case).
		h = h.replace(/(^|[^\w])_(?![\s_])([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>");
		return h;
	}

	// Block structure, line by line.
	let blocks = [];
	let paragraph = [];
	let quote = [];
	function flushParagraph() {
		if (paragraph.length > 0) {
			blocks.push("<p>" + paragraph.map(inline).join("<br/>") + "</p>");
			paragraph = [];
		}
	}
	function flushQuote() {
		if (quote.length > 0) {
			blocks.push("<blockquote><p>" + quote.map(inline).join("<br/>") + "</p></blockquote>");
			quote = [];
		}
	}

	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") {
			flushParagraph();
			flushQuote();
			continue;
		}
		const quoted = line.match(/^\s*>\s?(.*)$/);
		if (quoted) {
			flushParagraph();
			quote.push(quoted[1]);
			continue;
		}
		flushQuote();
		if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
			flushParagraph();
			blocks.push("<hr/>");
			continue;
		}
		if (trimmed === ":::") {
			flushParagraph();
			continue;
		}
		const spoiler = trimmed.match(/^:::\s*spoiler\s*(.*)$/i);
		if (spoiler) {
			flushParagraph();
			blocks.push("<p><strong>Spoiler: " + inline(spoiler[1]) + "</strong></p>");
			continue;
		}
		const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
		if (heading) {
			flushParagraph();
			blocks.push("<p><strong>" + inline(heading[1]) + "</strong></p>");
			continue;
		}
		const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
		if (bullet) {
			paragraph.push("• " + bullet[1]);
			continue;
		}
		paragraph.push(trimmed);
	}
	flushParagraph();
	flushQuote();

	// Restore protected HTML, and unwrap code blocks that ended up inside <p>.
	let html = blocks.join("");
	html = html.replace(/\uE000(\d+)\uE001/g, function (match, index) {
		return stash[parseInt(index)];
	});
	html = html.replace(/<p>(<pre><code>[\s\S]*?<\/code><\/pre>)<\/p>/g, "$1");
	return html;
}

/**
 * Pulls Markdown images (![alt](https://...)) out of a Markdown string.
 *
 * Tapestry does not render Markdown, and because this connector sets
 * provides_attachments to true it also does not auto-create attachments from
 * the body, so a raw image link would show up as literal text. This function
 * removes each image link from the text and returns it separately so it can
 * become a MediaAttachment.
 *
 * Returns { text, images } where `text` is the Markdown with the image links
 * (and any now-empty link wrappers such as [](https://...) left over from
 * clickable images) removed, and `images` is an Array of { url, alt } in the
 * order they appeared. An optional "title" after the URL is ignored.
 */
function extractMarkdownImages(markdown) {
	let images = [];
	if (!markdown) {
		return { text: "", images: images };
	}
	let text = markdown.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g, function (match, alt, url) {
		images.push({ url: url, alt: alt });
		return "";
	});
	// A clickable image ([![alt](img)](link)) leaves an empty link behind.
	text = text.replace(/\[\s*\]\([^)]*\)/g, "").trim();
	return { text: text, images: images };
}

/**
 * Converts the { url, alt } list from extractMarkdownImages() into an Array
 * of Tapestry MediaAttachments. The alt text becomes the attachment text
 * (used for accessibility). URLs in `skipUrls` are left out so an image that
 * is also the post's main link is not shown twice.
 */
function attachmentsForImages(images, skipUrls) {
	let attachments = [];
	for (const image of images) {
		if (skipUrls && skipUrls.indexOf(image.url) !== -1) {
			continue;
		}
		const media = MediaAttachment.createWithUrl(image.url);
		media.mediaType = "image";
		if (image.alt) {
			media.text = image.alt;
		}
		attachments.push(media);
	}
	return attachments;
}

/**
 * Parses a Lemmy timestamp into a Date. Lemmy returns ISO 8601 strings that
 * sometimes omit the trailing "Z"; this appends it so the value is read as UTC.
 */
function parseDate(text) {
	if (!text) {
		return new Date();
	}
	const hasZone = /Z$|[+-]\d\d:\d\d$/.test(text);
	return new Date(hasZone ? text : text + "Z");
}

/**
 * Returns true when a URL points at an image file, judged by extension.
 * Used to decide between a MediaAttachment and a LinkAttachment.
 */
function isImageUrl(url) {
	return /\.(png|jpe?g|gif|webp|bmp)(\?.*)?$/i.test(url || "");
}

// ---------------------------------------------------------------------------
// Item construction
// ---------------------------------------------------------------------------

/**
 * Applies the vote actions to an item (a post OR a comment) based on the
 * user's current vote (1 = upvoted, -1 = downvoted, 0 = none). Existing vote
 * actions are cleared first so the Set always reflects the current state.
 * Non-vote actions (comment, reply, thread) are managed by the callers that
 * create the item and are left untouched here.
 */
function applyVoteActions(item, myVote) {
	item.actions.delete("upvote");
	item.actions.delete("downvote");
	item.actions.delete("clear_vote");

	if (myVote !== 1) {
		item.actions.add("upvote");
	}
	if (myVote !== -1) {
		item.actions.add("downvote");
	}
	if (myVote === 1 || myVote === -1) {
		item.actions.add("clear_vote");
	}
}

/**
 * Builds the single annotation shown above a post: community name, score,
 * vote marker, and comment count, linking to the community page.
 */
function annotationForPost(postView) {
	const community = postView.community;
	const host = (community.actor_id || "").split("/")[2] || "";
	const name = "!" + community.name + (host ? "@" + host : "");
	const marker = (postView.my_vote === 1) ? " ▲" : ((postView.my_vote === -1) ? " ▼" : "");
	const annotation = Annotation.createWithText(
		name + " · " + postView.counts.score + " points" + marker + " · " + postView.counts.comments + " comments"
	);
	annotation.uri = community.actor_id;
	if (community.icon) {
		annotation.icon = community.icon;
	}
	return annotation;
}

/**
 * Converts one Lemmy PostView into a Tapestry Item.
 *
 * - Title and Markdown body become the item title and HTML body.
 * - The creator becomes the author Identity.
 * - Image URLs become MediaAttachments; other URLs become LinkAttachments
 *   built from Lemmy's pre-fetched embed metadata (provides_attachments is
 *   true, so Tapestry will not re-scrape the body).
 * - Metadata carries the post id (as a string) for actions.
 */
function itemForPostView(postView) {
	const post = postView.post;
	const creator = postView.creator;

	// ap_id is the canonical federated URL of the post and opens in a browser.
	const item = Item.createWithUriDate(post.ap_id, parseDate(post.published));
	item.title = post.name;
	// Markdown images in the body become media attachments (see below).
	const bodyParts = extractMarkdownImages(post.body);
	item.body = markdownToHtml(bodyParts.text);

	const creatorHost = (creator.actor_id || "").split("/")[2] || "";
	item.author = Identity.create(
		creator.display_name || creator.name,
		creator.name + (creatorHost ? "@" + creatorHost : ""),
		creator.avatar || DEFAULT_AVATAR,
		creator.actor_id
	);

	let attachments = [];
	if (post.url && isImageUrl(post.url)) {
		const media = MediaAttachment.createWithUrl(post.url);
		if (post.thumbnail_url) {
			media.thumbnail = post.thumbnail_url;
		}
		attachments.push(media);
	}
	else if (post.url) {
		const link = LinkAttachment.createWithUrl(post.url);
		link.title = post.embed_title || post.name;
		if (post.embed_description) {
			link.subtitle = post.embed_description;
		}
		if (post.thumbnail_url) {
			link.image = post.thumbnail_url;
		}
		attachments.push(link);
	}
	else if (post.thumbnail_url) {
		attachments.push(MediaAttachment.createWithUrl(post.thumbnail_url));
	}
	attachments = attachments.concat(attachmentsForImages(bodyParts.images, [post.url]));
	if (attachments.length > 0) {
		item.attachments = attachments;
	}

	if (post.nsfw || (postView.community && postView.community.nsfw)) {
		item.contentWarning = "NSFW";
	}

	item.annotations = [annotationForPost(postView)];

	// Metadata values must be strings.
	item.metadata = { kind: "post", postId: String(post.id) };
	applyVoteActions(item, postView.my_vote || 0);
	item.actions.add("comment");
	// Like Mastodon and Bluesky: a different thread icon when replies exist.
	// "thread_replies" and "thread" are the same action; only the icon differs.
	item.actions.add((postView.counts.comments > 0) ? "thread_replies" : "thread");

	return item;
}

// ---------------------------------------------------------------------------
// Comments: tree ordering and item construction
// ---------------------------------------------------------------------------

/**
 * Returns a comment's nesting depth from its Lemmy "path" string.
 * Paths look like "0.123.456": the leading 0 is the root marker and the last
 * number is the comment itself, so a top-level comment ("0.123") is depth 0.
 */
function commentDepth(path) {
	return Math.max(0, String(path).split(".").length - 2);
}

/**
 * Returns the id (as a string) of a comment's parent, or "0" for a top-level
 * comment, taken from the second-to-last segment of its Lemmy "path".
 */
function commentParentId(path) {
	const segments = String(path).split(".");
	return (segments.length >= 3) ? segments[segments.length - 2] : "0";
}

/**
 * Orders a flat list of Lemmy CommentViews into a depth-first thread.
 *
 * Lemmy's response order is not relied upon. Instead the tree is rebuilt from
 * each comment's path: siblings are sorted by score (highest first, oldest
 * first on ties) and walked depth-first so every reply directly follows its
 * parent. A comment whose parent was not fetched (for example, beyond the
 * page cap) is treated as top-level so it is never lost.
 */
function orderCommentTree(commentViews) {
	let knownIds = {};
	for (const view of commentViews) {
		knownIds[String(view.comment.id)] = true;
	}

	let childrenByParent = {};
	for (const view of commentViews) {
		let parentId = commentParentId(view.comment.path);
		if (parentId !== "0" && !knownIds[parentId]) {
			parentId = "0";
		}
		if (!childrenByParent[parentId]) {
			childrenByParent[parentId] = [];
		}
		childrenByParent[parentId].push(view);
	}

	let ordered = [];
	function walk(parentId) {
		const children = childrenByParent[parentId] || [];
		children.sort(function (a, b) {
			if (b.counts.score !== a.counts.score) {
				return b.counts.score - a.counts.score;
			}
			return parseDate(a.comment.published) - parseDate(b.comment.published);
		});
		for (const child of children) {
			ordered.push(child);
			walk(String(child.comment.id));
		}
	}
	walk("0");
	return ordered;
}

/**
 * Builds the annotation shown above a comment: a nesting marker (one arrow
 * per level, capped at six), the score, and the viewer's vote marker.
 */
function annotationForComment(commentView) {
	const depth = commentDepth(commentView.comment.path);
	const label = (depth === 0) ? "Comment" : ("↳".repeat(Math.min(depth, 6)) + " Reply");
	const marker = (commentView.my_vote === 1) ? " ▲" : ((commentView.my_vote === -1) ? " ▼" : "");
	return Annotation.createWithText(label + " · " + commentView.counts.score + " points" + marker);
}

/**
 * Converts one Lemmy CommentView into a Tapestry Item.
 *
 * - The comment's canonical federated URL (ap_id) is the item URI.
 * - Deleted or removed comments show a placeholder instead of their content.
 * - Metadata carries kind="comment", the comment id, and the parent post id
 *   (needed to post a reply).
 * - Actions: vote actions plus "reply".
 */
function itemForCommentView(commentView) {
	const comment = commentView.comment;
	const creator = commentView.creator;

	const item = Item.createWithUriDate(comment.ap_id, parseDate(comment.published));

	if (comment.deleted) {
		item.body = "<p><em>[deleted]</em></p>";
	}
	else if (comment.removed) {
		item.body = "<p><em>[removed]</em></p>";
	}
	else {
		// Markdown images in the comment become media attachments.
		const contentParts = extractMarkdownImages(comment.content);
		item.body = markdownToHtml(contentParts.text);
		const images = attachmentsForImages(contentParts.images, null);
		if (images.length > 0) {
			item.attachments = images;
		}
	}

	const creatorHost = (creator.actor_id || "").split("/")[2] || "";
	item.author = Identity.create(
		creator.display_name || creator.name,
		creator.name + (creatorHost ? "@" + creatorHost : ""),
		creator.avatar || DEFAULT_AVATAR,
		creator.actor_id
	);

	item.annotations = [annotationForComment(commentView)];

	item.metadata = { kind: "comment", commentId: String(comment.id), postId: String(comment.post_id) };
	applyVoteActions(item, commentView.my_vote || 0);
	item.actions.add("reply");

	return item;
}

// ---------------------------------------------------------------------------
// Interface functions called by Tapestry
// ---------------------------------------------------------------------------

/**
 * Called by Tapestry to validate the instance and credentials.
 * Logs in fresh (discarding any cached token), then reads the account's
 * profile from /api/v3/site so the feed can be named "@user@instance" and
 * given the account avatar. Returns the verification object; throws on failure.
 */
async function verify() {
	setItem(JWT_KEY, null);
	await login();
	const json = await authed(function (jwt) {
		return fetch.get(baseUrl() + "/api/v3/site", { headers: authHeaders(jwt) });
	});
	const person = json.my_user.local_user_view.person;
	const host = baseUrl().split("/")[2] || "";
	const fullName = "@" + person.name + "@" + host;
	return {
		displayName: fullName,
		icon: person.avatar || DEFAULT_AVATAR,
		accountIdentity: Identity.create(person.display_name || person.name, fullName, person.avatar || DEFAULT_AVATAR)
	};
}

/**
 * Called by Tapestry to refresh the timeline.
 *
 * Requests the "Subscribed" feed page by page, sequentially, up to the
 * "pages" setting, stopping early when Lemmy returns a short page. NSFW posts
 * are dropped unless the "Show NSFW posts" switch is on. Returns the Array of
 * Items; throws on failure.
 */
async function load() {
	const maxPages = parseInt(pages) || 1;
	let results = [];

	for (let page = 1; page <= maxPages; page++) {
		const json = await authed(function (jwt) {
			return fetch.get(baseUrl() + "/api/v3/post/list", {
				params: { type_: "Subscribed", sort: sort, limit: String(PAGE_SIZE), page: String(page) },
				headers: authHeaders(jwt)
			});
		});
		const postViews = json.posts || [];

		for (const postView of postViews) {
			const isNsfw = postView.post.nsfw || (postView.community && postView.community.nsfw);
			if (isNsfw && showNsfw !== "on") {
				continue;
			}
			results.push(itemForPostView(postView));
		}

		if (postViews.length < PAGE_SIZE) {
			break;
		}
	}

	return results;
}

/**
 * Sends a vote to Lemmy. score: 1 = upvote, -1 = downvote, 0 = remove vote.
 * Returns the updated PostView from the response so the item can be refreshed.
 */
async function votePost(postId, score) {
	const json = await authed(function (jwt) {
		return fetch.post(baseUrl() + "/api/v3/post/like", {
			json: { post_id: parseInt(postId), score: score },
			headers: authHeaders(jwt)
		});
	});
	return json.post_view;
}

/**
 * Sends a vote on a comment. score: 1 = upvote, -1 = downvote, 0 = remove.
 * Returns the updated CommentView from the response.
 */
async function voteComment(commentId, score) {
	const json = await authed(function (jwt) {
		return fetch.post(baseUrl() + "/api/v3/comment/like", {
			json: { comment_id: parseInt(commentId), score: score },
			headers: authHeaders(jwt)
		});
	});
	return json.comment_view;
}

/**
 * Posts a comment on a Lemmy post. When parentId is a number the comment is a
 * reply to that comment; when it is null the comment is top-level. Throws on
 * failure; the composer stays open with the draft intact and shows the error.
 */
async function postComment(postId, parentId, content) {
	let body = { post_id: parseInt(postId), content: content };
	if (parentId != null) {
		body.parent_id = parentId;
	}
	return await authed(function (jwt) {
		return fetch.post(baseUrl() + "/api/v3/comment", {
			json: body,
			headers: authHeaders(jwt)
		});
	});
}

/**
 * Loads the full comment thread for a post (the "thread" context action).
 *
 * Fetches comments page by page (up to MAX_COMMENT_PAGES), orders them into a
 * depth-first tree, and returns an Array with the post item FIRST, followed by
 * every comment. Tapestry shows the array in the order given and drops any
 * item not included, so the post item must be part of the result.
 */
async function loadThread(postItem) {
	const postId = postItem.metadata.postId;
	let commentViews = [];

	for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
		const json = await authed(function (jwt) {
			return fetch.get(baseUrl() + "/api/v3/comment/list", {
				params: {
					post_id: postId,
					type_: "All",
					sort: "Top",
					max_depth: String(MAX_COMMENT_DEPTH),
					limit: String(COMMENT_PAGE_SIZE),
					page: String(page)
				},
				headers: authHeaders(jwt)
			});
		});
		const views = json.comments || [];
		commentViews = commentViews.concat(views);
		if (views.length < COMMENT_PAGE_SIZE) {
			break;
		}
	}

	return [postItem].concat(orderCommentTree(commentViews).map(itemForCommentView));
}

/**
 * Builds the Draft that opens the composer for a comment on `item`.
 *
 * `item` is either a post (a top-level comment) or a comment (a reply).
 *
 * - header: composer heading (not part of the comment).
 * - context: the item being answered, shown above the editor.
 * - metadata: carries the post id and the parent comment id ("" for a
 *   top-level comment) to the submit action.
 * - rules: enables only the body field, with Lemmy's length limit counted in
 *   Unicode code points and a placeholder.
 * - actions: adds the "send_comment" submit button.
 */
function draftForReply(item) {
	const isReply = (item.metadata.kind === "comment");
	const draft = Draft.create();
	draft.header = isReply
		? "Reply to " + ((item.author && item.author.name) || "comment")
		: "Comment on " + item.title;
	draft.context = [item];
	draft.metadata = {
		postId: item.metadata.postId,
		parentId: isReply ? item.metadata.commentId : ""
	};
	draft.rules = {
		characterUnit: "codepoints",
		characterCounter: {
			fields: ["body"],
			characterLimit: { maxLength: COMMENT_MAX_LENGTH }
		},
		fields: {
			body: { placeholder: isReply ? "Write a reply" : "Add a comment", availability: "required" }
		}
	};
	draft.actions.add("send_comment");
	return draft;
}

/**
 * Called by Tapestry when the user taps an action.
 *
 * - "upvote" / "downvote" / "clear_vote": target is a post or comment Item
 *   (told apart by item.metadata.kind). The vote is sent, then the item's
 *   annotation and actions are rebuilt from Lemmy's response and the updated
 *   item is returned.
 * - "comment" (on a post) / "reply" (on a comment): returns a Draft, which
 *   opens the composer.
 * - "thread" / "thread_replies": context action on a post (the two differ
 *   only in icon: replies exist or not); returns the post followed by its
 *   comment tree.
 * - "send_comment": target is the edited Draft. Posts the comment or reply
 *   and returns nothing, which closes the composer.
 *
 * Errors are thrown so Tapestry can display them.
 */
async function performAction(actionId, target, actionValue) {
	if (actionId === "upvote" || actionId === "downvote" || actionId === "clear_vote") {
		const item = target;
		const score = (actionId === "upvote") ? 1 : ((actionId === "downvote") ? -1 : 0);

		if (item.metadata.kind === "comment") {
			const commentView = await voteComment(item.metadata.commentId, score);
			item.annotations = [annotationForComment(commentView)];
			applyVoteActions(item, commentView.my_vote || 0);
			return item;
		}

		const postView = await votePost(item.metadata.postId, score);
		item.annotations = [annotationForPost(postView)];
		applyVoteActions(item, postView.my_vote || 0);
		return item;
	}
	else if (actionId === "comment" || actionId === "reply") {
		return draftForReply(target);
	}
	else if (actionId === "thread" || actionId === "thread_replies") {
		return await loadThread(target);
	}
	else if (actionId === "send_comment") {
		const draft = target;
		const content = (draft.body || "").trim();
		if (content.length === 0) {
			throw new Error("A comment can't be empty.");
		}
		const parentId = draft.metadata.parentId ? parseInt(draft.metadata.parentId) : null;
		await postComment(draft.metadata.postId, parentId, content);
		return;
	}

	throw new Error("Unknown action: " + actionId);
}