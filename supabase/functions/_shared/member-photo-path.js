export function isMemberPhotoPathOwnedByUser(userId, photoPath) {
  if (typeof userId !== "string" || !userId ||
      typeof photoPath !== "string" || !photoPath ||
      /^https?:\/\//i.test(photoPath) || photoPath.includes("\\")) {
    return false;
  }

  const segments = photoPath.split("/");
  return segments.length >= 2 &&
    segments[0] === userId &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

// The small copy of a photo: same folder, "thumb_" + name, always .jpg. Keep in step with
// thumbPathFor() in assets/member-core.js and public.pk_thumb_path() in photo_thumbnails.sql.
export function thumbPathFor(photoPath) {
  if (typeof photoPath !== "string" || !photoPath) return null;
  const cut = photoPath.lastIndexOf("/") + 1;
  const base = photoPath.slice(cut);
  const dot = base.lastIndexOf(".");
  return photoPath.slice(0, cut) + "thumb_" + (dot > -1 ? base.slice(0, dot) : base) + ".jpg";
}
