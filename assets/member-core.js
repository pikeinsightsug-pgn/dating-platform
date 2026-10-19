// Shared member-area helpers for account, dashboard, discovery and messages pages.
// Only the public publishable key belongs here; never add a service-role key.
(function (root) {
  "use strict";

  const SUPABASE_URL = "https://cyvkpcwjkeifpvegwhpt.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_vzGFbhe7X3CpobiHZAk9Lw_2V3O-F3V";
  // Official contact address, shown as a clickable link on every member page.
  const CONTACT_EMAIL = "pikeinsightsug@gmail.com";
  const REQUEST_TIMEOUT_MS = 60000;
  const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
  const GENDERS = ["Woman", "Man", "Non-binary", "Prefer not to say"];
  const COUNTRIES = ["Uganda", "Botswana"];
  const GOALS = ["Serious relationship", "Marriage", "Friendship", "Exploring connections"];
  // Stored values stay as above (the database checks them); these are the labels people see.
  const GOAL_LABELS = {
    "Serious relationship": "Serious relationship",
    "Marriage": "Marriage-oriented relationship",
    "Friendship": "Friendship",
    "Exploring connections": "Still exploring"
  };
  const SEEKING = ["Men", "Women", "Everyone"];
  // Columns added by supabase/discovery_messaging_safety.sql. Until that file is applied,
  // writes are retried without them so registration and profile saving keep working.
  const PREFERENCE_COLUMNS = ["seeking_gender", "preferred_age_min", "preferred_age_max"];

  // Bound every Supabase request so a stalled token refresh or upload can never
  // leave a button spinning forever.
  function boundedFetch(fetchImpl, baseUrl, timeoutMs) {
    const origin = new URL(baseUrl).origin;
    return function (input, init = {}) {
      const requestUrl = typeof input === "string" ? input : input.url;
      if (new URL(requestUrl, baseUrl).origin !== origin) return fetchImpl(input, init);
      const controller = new AbortController();
      const callerSignal = init.signal ||
        (typeof Request !== "undefined" && input instanceof Request ? input.signal : null);
      const abortFromCaller = () => controller.abort();
      if (callerSignal) {
        if (callerSignal.aborted) controller.abort();
        else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return fetchImpl(input, { ...init, signal: controller.signal })
        .catch(error => {
          if (controller.signal.aborted && !(callerSignal && callerSignal.aborted)) {
            const timeoutError = new Error("The Supabase request timed out.");
            timeoutError.code = "REQUEST_TIMEOUT";
            throw timeoutError;
          }
          throw error;
        })
        .finally(() => {
          clearTimeout(timer);
          if (callerSignal) callerSignal.removeEventListener("abort", abortFromCaller);
        });
    };
  }

  function createClient() {
    if (!root.supabase || typeof root.supabase.createClient !== "function") return null;
    const url = root.FYP_SUPABASE_URL || SUPABASE_URL;
    return root.supabase.createClient(url, SUPABASE_PUBLISHABLE_KEY, {
      global: { fetch: boundedFetch(root.fetch.bind(root), url, REQUEST_TIMEOUT_MS) }
    });
  }

  // The profile a person typed into account.html at signup, stored on their own Auth user.
  function profileFromMetadata(user) {
    const meta = (user && user.user_metadata) || {};
    if (meta.profile_type !== "member_registration") return null;
    const age = Number(meta.age);
    const text = value => String(value == null ? "" : value).trim();
    const profile = {
      user_id: user.id,
      first_name: text(meta.first_name),
      age,
      gender: text(meta.gender),
      location: text(meta.location),
      city: text(meta.city),
      relationship_goal: text(meta.relationship_goal),
      bio: text(meta.bio),
      interests: text(meta.interests),
      partner_preference: text(meta.partner_preference),
      approved: false
    };
    const seeking = text(meta.seeking_gender);
    const ageMin = Number(meta.preferred_age_min), ageMax = Number(meta.preferred_age_max);
    if (SEEKING.includes(seeking)) profile.seeking_gender = seeking;
    if (Number.isInteger(ageMin) && Number.isInteger(ageMax) && ageMin >= 18 && ageMax <= 120 && ageMin <= ageMax) {
      profile.preferred_age_min = ageMin;
      profile.preferred_age_max = ageMax;
    }
    if (!profile.first_name || profile.first_name.length > 80 ||
        !Number.isInteger(age) || age < 18 || age > 120 ||
        !GENDERS.includes(profile.gender) || !COUNTRIES.includes(profile.location) ||
        !profile.city || profile.city.length > 100 || !GOALS.includes(profile.relationship_goal) ||
        !profile.bio || profile.bio.length > 500 ||
        profile.interests.length > 300 || profile.partner_preference.length > 500) return null;
    return profile;
  }

  // A member can only ever read their own row (RLS). "*" keeps this working whether or not
  // the optional preference columns exist yet.
  async function readOwnProfile(db, user) {
    const { data, error } = await db.from("members").select("*").eq("user_id", user.id).limit(1);
    if (error) {
      const failure = new Error("Your private profile could not be loaded. Check your connection and try again.");
      failure.cause = error;
      throw failure;
    }
    return data && data.length ? data[0] : null;
  }

  // Returns the member row linked to this Auth user. If none exists and the user signed
  // up through account.html, creates one pending profile from their own signup details
  // (the database trigger normally does this at email confirmation; this covers projects
  // where it did not run). Never links or guesses a legacy registration.
  async function ensureOwnProfile(db, user) {
    const existing = await readOwnProfile(db, user);
    if (existing) return existing;
    const profile = profileFromMetadata(user);
    if (!profile) return null;
    const { error } = await withoutMissingColumns(profile, row => db.from("members").insert(row));
    if (error && error.code !== "23505") {
      // A concurrent tab or the trigger may have created it; read again before failing.
      const raced = await readOwnProfile(db, user);
      if (raced) return raced;
      const failure = new Error("Your account is signed in, but your profile could not be saved. Please email " + CONTACT_EMAIL + ".");
      failure.cause = error;
      throw failure;
    }
    return readOwnProfile(db, user);
  }

  // PGRST204: the column is not in the database yet (migration not applied).
  function isMissingColumn(error) {
    return Boolean(error) && (error.code === "PGRST204" || error.code === "42703" ||
      /column .* (does not exist|could not find)|could not find the .* column/i.test(String(error.message || "")));
  }
  async function withoutMissingColumns(row, write) {
    const result = await write(row);
    if (!isMissingColumn(result.error) || !PREFERENCE_COLUMNS.some(c => c in row)) return result;
    const reduced = { ...row };
    PREFERENCE_COLUMNS.forEach(c => delete reduced[c]);
    return write(reduced);
  }
  async function saveOwnProfile(db, user, payload) {
    return withoutMissingColumns(payload, row => db.from("members").update(row).eq("user_id", user.id).select("id").maybeSingle());
  }

  // The single client-side gate for member features (discovery, profiles, messaging).
  // Today it is owner approval; a future paid-access check belongs here and in the
  // database's require_approved_member(), never in a page of its own.
  function canUseMemberFeatures(profile) {
    return Boolean(profile && profile.approved === true);
  }

  // Shows which account this browser is signed in to, so two test accounts are never confused.
  function showSignedIn(profile, user) {
    const node = typeof document !== "undefined" && document.getElementById("signed-in");
    if (!node) return;
    const name = profile && profile.first_name ? profile.first_name : "your account";
    node.textContent = "Signed in as " + name + (user && user.email ? " (" + user.email + ")" : "");
    node.classList.remove("hidden");
  }

  function destinationFor(profile) {
    if (!profile) return "dashboard.html?profile=recovery";
    return canUseMemberFeatures(profile) ? "discover.html" : "dashboard.html";
  }

  function authErrorMessage(error, action) {
    const message = String((error && error.message) || "").toLowerCase();
    const code = String((error && error.code) || "").toLowerCase();
    const status = Number(error && error.status);
    if (error && error.code === "REQUEST_TIMEOUT") return "The request timed out. Check your connection and try again.";
    if (message.includes("failed to fetch") || message.includes("network")) return "Could not reach the account service. Check your connection and try again.";
    if (code === "email_not_confirmed" || message.includes("email not confirmed")) return "Please confirm your email address first. Use the link we emailed you, or resend it below.";
    if (code === "invalid_credentials" || message.includes("invalid login credentials")) return "That email and password do not match an account. Check them, or use “Forgot password?”.";
    if (code === "user_already_exists" || message.includes("already registered")) return "An account with this email already exists. Log in instead, or reset your password.";
    if (code === "weak_password" || message.includes("password should")) return "Choose a stronger password: at least 8 characters, mixing letters and numbers.";
    if (status === 429 || code.includes("rate_limit") || message.includes("rate limit")) return "Too many attempts. Please wait a few minutes and try again.";
    if (code === "signup_disabled" || message.includes("signups not allowed")) return "New registrations are paused right now. Please email " + CONTACT_EMAIL + ".";
    if (message.includes("database error saving new user")) return "Your account could not be created because of a server setup problem. Please email " + CONTACT_EMAIL + ".";
    return action === "signup"
      ? "Could not create the account. Check the details and try again. If the problem continues, email " + CONTACT_EMAIL + "."
      : "Could not sign in right now. Please try again. If the problem continues, email " + CONTACT_EMAIL + ".";
  }

  // Some Android pickers report an empty MIME type, so fall back to the file extension.
  // A random identifier for new photo file names. crypto.randomUUID is missing on some older
  // Android browsers and in-app browsers (such as Facebook's); fall back to getRandomValues.
  function randomId() {
    const c = root.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  // Rejects with code OPERATION_TIMEOUT if the promise has not settled in time, so a step that is
  // not an HTTP request (and so not covered by boundedFetch) can never leave a spinner running.
  function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("The operation took too long."), { code: "OPERATION_TIMEOUT" })), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function photoTypeOf(file) {
    const type = String((file && file.type) || "").toLowerCase();
    if (type) return type === "image/jpg" ? "image/jpeg" : type;
    const name = String((file && file.name) || "").toLowerCase();
    if (/\.(jpe?g|jfif)$/.test(name)) return "image/jpeg";
    if (/\.png$/.test(name)) return "image/png";
    if (/\.webp$/.test(name)) return "image/webp";
    if (/\.(heic|heif)$/.test(name)) return "image/heic";
    return "";
  }

  const PHOTO_MAX_EDGE = 1600;
  const PHOTO_RECOMPRESS_BYTES = 1.5 * 1024 * 1024;

  function decodeImage(file) {
    if (typeof root.createImageBitmap === "function") {
      return root.createImageBitmap(file).catch(() => decodeWithElement(file));
    }
    return decodeWithElement(file);
  }
  function decodeWithElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
      image.src = url;
    });
  }

  // supabase-js uploads a File/Blob as multipart and ignores the contentType option, so the
  // Blob itself must carry the right type. Android files with an empty type would otherwise
  // arrive as application/octet-stream and be refused by the bucket's allowed types.
  function typedOriginal(file, type) {
    const blob = file.type === type ? file : new Blob([file], { type });
    return { blob, type, extension: type === "image/jpeg" ? "jpg" : type.split("/")[1] };
  }

  // Phone photos are often larger than 5 MB or in HEIC. Re-encode those as a JPEG no
  // larger than 1600px on the long edge so uploads finish quickly on mobile data.
  async function preparePhoto(file) {
    const type = photoTypeOf(file);
    const supported = PHOTO_TYPES.includes(type);
    const convertible = supported || type === "image/heic" || type === "image/heif" || type.startsWith("image/");
    if (!file || !convertible) {
      throw Object.assign(new Error("Choose a photo in JPEG, PNG or WebP format."), { code: "PHOTO_TYPE" });
    }
    if (supported && file.size <= PHOTO_RECOMPRESS_BYTES) return typedOriginal(file, type);
    let image;
    try { image = await decodeImage(file); }
    catch (error) {
      if (supported && file.size <= PHOTO_MAX_BYTES) return typedOriginal(file, type);
      throw Object.assign(new Error(supported
        ? "This photo is larger than 5 MB and could not be resized on this device. Choose a smaller photo."
        : "This phone saved the photo in a format we cannot read (such as HEIC). Change the camera setting to “Most compatible”, or take a screenshot of the photo and upload that."), { code: "PHOTO_DECODE" });
    }
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    if (typeof image.close === "function") image.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size > PHOTO_MAX_BYTES) {
      throw Object.assign(new Error("This photo could not be made small enough. Choose a different photo."), { code: "PHOTO_SIZE" });
    }
    return { blob, type: "image/jpeg", extension: "jpg" };
  }

  async function signedPhotoUrls(db, paths) {
    const unique = [...new Set(paths.filter(Boolean))];
    const urls = new Map();
    if (!unique.length) return urls;
    try {
      const { data, error } = await db.storage.from("profile-photos").createSignedUrls(unique, 600);
      if (error || !Array.isArray(data)) return urls;
      data.forEach(item => { if (item && item.signedUrl && !item.error) urls.set(item.path, item.signedUrl); });
    } catch (error) {
      // A missing photo must never break the page; cards fall back to a placeholder.
    }
    return urls;
  }

  // True when a database function has not been installed yet (migration not applied).
  function isMissingFunction(error) {
    const code = String((error && error.code) || "");
    const message = String((error && error.message) || "");
    return code === "PGRST202" || code === "42883" || /could not find the function/i.test(message);
  }
  function isNotApproved(error) {
    return /only approved adult members/i.test(String((error && error.message) || ""));
  }

  const api = {
    SUPABASE_URL, CONTACT_EMAIL, SUPABASE_PUBLISHABLE_KEY, PHOTO_TYPES, PHOTO_MAX_BYTES, GENDERS, COUNTRIES, GOALS,
    GOAL_LABELS, SEEKING, boundedFetch, createClient, profileFromMetadata, readOwnProfile, ensureOwnProfile,
    saveOwnProfile, isMissingColumn, canUseMemberFeatures, destinationFor, showSignedIn,
    authErrorMessage, photoTypeOf, preparePhoto, decodeImage, randomId, withTimeout, signedPhotoUrls, isMissingFunction, isNotApproved
  };
  root.FYP = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
