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
