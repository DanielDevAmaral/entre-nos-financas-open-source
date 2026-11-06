import sharp from "sharp";
for (const [size, name] of [
  [192, "icon-192"],
  [512, "icon-512"],
  [180, "apple-touch-icon"],
  [1024, "ios-icon-1024"],
]) {
  await sharp("public/icons/afinidade-source.png")
    .resize(size, size)
    .flatten({ background: "#71566f" })
    .png()
    .toFile(`public/icons/${name}-v3.png`);
}
