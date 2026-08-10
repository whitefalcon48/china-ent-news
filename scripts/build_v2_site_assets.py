from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "docs" / "assets" / "character-v2" / "production"
OUTPUT_DIR = ROOT / "docs" / "assets" / "site"
FONT_SC = Path(r"C:\Windows\Fonts\NotoSerifSC-VF.ttf")
FONT_JP = Path(r"C:\Windows\Fonts\NotoSerifJP-VF.ttf")

ICE_BLUE = "#4A9FE3"
RUBY_RED = "#D62F2A"
NAVY = "#18375F"

AVATAR_NAMES = [
    "smile-left",
    "smile-right",
    "joy-front",
    "joy-left",
    "surprise-front",
    "surprise-right",
    "thinking-left",
    "thinking-up",
    "serious-front",
    "serious-right",
]


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    build_logos()
    build_character_assets()
    print(f"Built V2 site assets in {OUTPUT_DIR}")


def build_logos() -> None:
    horizontal = Image.new("RGBA", (1400, 310), (255, 255, 255, 0))
    draw = ImageDraw.Draw(horizontal)
    chinese_font = ImageFont.truetype(str(FONT_SC), 128)
    japanese_font = ImageFont.truetype(str(FONT_JP), 43)
    x = 88
    y = 24
    positions: dict[str, tuple[int, int, int, int]] = {}
    for character, color in [("冰", ICE_BLUE), ("糖", RUBY_RED)]:
        box = draw.textbbox((x, y), character, font=chinese_font)
        draw.text((x, y), character, font=chinese_font, fill=color)
        positions[character] = box
        x = box[2] + 8
    x += 52
    for character in "日报":
        box = draw.textbbox((x, y), character, font=chinese_font)
        draw.text((x, y), character, font=chinese_font, fill=NAVY)
        x = box[2] + 8
    draw.text((92, 190), "ビンタンデイリー", font=japanese_font, fill=RUBY_RED)
    draw_sugar_sparkle(draw, 70, 64, 18)
    sugar_box = positions["糖"]
    draw_hawthorn_mark(draw, sugar_box[2] - 4, 63, 15)
    horizontal = crop_transparent(horizontal, padding=24)
    horizontal.save(OUTPUT_DIR / "bingtang-logo-horizontal.png", optimize=True)

    compact = Image.new("RGBA", (512, 512), (255, 255, 255, 0))
    draw = ImageDraw.Draw(compact)
    compact_font = ImageFont.truetype(str(FONT_SC), 150)
    draw.text((68, 42), "冰", font=compact_font, fill=ICE_BLUE)
    draw.text((242, 42), "糖", font=compact_font, fill=RUBY_RED)
    draw.text((68, 230), "日报", font=compact_font, fill=NAVY, spacing=4)
    draw_sugar_sparkle(draw, 55, 79, 16)
    draw_hawthorn_mark(draw, 384, 82, 14)
    compact.save(OUTPUT_DIR / "bingtang-logo-compact.png", optimize=True)
    compact.resize((48, 48), Image.Resampling.LANCZOS).save(OUTPUT_DIR / "favicon-48.png", optimize=True)
    compact.resize((32, 32), Image.Resampling.LANCZOS).save(OUTPUT_DIR / "favicon-32.png", optimize=True)


def draw_sugar_sparkle(draw: ImageDraw.ImageDraw, x: int, y: int, radius: int) -> None:
    color = ICE_BLUE
    draw.polygon([(x, y - radius), (x + 4, y - 4), (x + radius, y), (x + 4, y + 4), (x, y + radius), (x - 4, y + 4), (x - radius, y), (x - 4, y - 4)], fill=color)
    draw.ellipse((x - radius - 12, y - radius + 2, x - radius - 5, y - radius + 9), fill=color)
    draw.ellipse((x + radius + 4, y + radius - 4, x + radius + 10, y + radius + 2), fill=color)


def draw_hawthorn_mark(draw: ImageDraw.ImageDraw, x: int, y: int, radius: int) -> None:
    for angle in range(0, 360, 72):
        radians = math.radians(angle - 90)
        cx = x + math.cos(radians) * radius * 0.72
        cy = y + math.sin(radians) * radius * 0.72
        petal = radius * 0.62
        draw.ellipse((cx - petal, cy - petal, cx + petal, cy + petal), fill=RUBY_RED)
    draw.ellipse((x - radius * 0.32, y - radius * 0.32, x + radius * 0.32, y + radius * 0.32), fill="#FFFFFF")


def crop_transparent(image: Image.Image, padding: int) -> Image.Image:
    # Transparent chroma-key pixels can retain non-zero RGB values. Use only
    # the alpha channel for bounds so invisible colour data does not become
    # artificial padding around the character.
    if image.mode == "RGBA":
        visible_alpha = image.getchannel("A").point(lambda value: 255 if value >= 48 else 0)
        bbox = visible_alpha.getbbox()
    else:
        bbox = image.getbbox()
    if not bbox:
        return image
    left = max(0, bbox[0] - padding)
    top = max(0, bbox[1] - padding)
    right = min(image.width, bbox[2] + padding)
    bottom = min(image.height, bbox[3] + padding)
    return image.crop((left, top, right, bottom))


def build_character_assets() -> None:
    hero = Image.open(SOURCE_DIR / "bingtang-hero-chroma.png").convert("RGB")
    remove_chroma(hero).save(OUTPUT_DIR / "bingtang-hero-v2.png", optimize=True)

    sheet = Image.open(SOURCE_DIR / "bingtang-reactions-chroma.png").convert("RGB")
    for index, name in enumerate(AVATAR_NAMES):
        column = index % 5
        row = index // 5
        left = round(column * sheet.width / 5)
        right = round((column + 1) * sheet.width / 5)
        top = round(row * sheet.height / 2)
        bottom = round((row + 1) * sheet.height / 2)
        cell = sheet.crop((left, top, right, bottom))
        # The generated cells are portrait-shaped. Preserve that ratio instead of
        # stretching each cell into a square, then center it on a transparent canvas.
        avatar_source = crop_transparent(remove_chroma(cell), padding=8)
        # Keep the head and shoulders, but trim the lower torso so expressions
        # remain readable in the small circular UI treatment.
        focus_height = round(avatar_source.height * 0.78)
        avatar_source = crop_transparent(
            avatar_source.crop((0, 0, avatar_source.width, focus_height)),
            padding=6,
        )
        scale = min(488 / avatar_source.width, 488 / avatar_source.height)
        avatar_source = avatar_source.resize(
            (round(avatar_source.width * scale), round(avatar_source.height * scale)),
            Image.Resampling.LANCZOS,
        )
        avatar = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
        avatar.alpha_composite(
            avatar_source,
            ((512 - avatar_source.width) // 2, (512 - avatar_source.height) // 2),
        )
        avatar.save(OUTPUT_DIR / f"bingtang-avatar-{name}.png", optimize=True)


def remove_chroma(image: Image.Image) -> Image.Image:
    key = (0, 255, 0)
    transparent_threshold = 20.0
    opaque_threshold = 165.0
    output: list[tuple[int, int, int, int]] = []
    for red, green, blue in image.getdata():
        distance = math.sqrt((red - key[0]) ** 2 + (green - key[1]) ** 2 + (blue - key[2]) ** 2)
        if distance <= transparent_threshold:
            output.append((red, green, blue, 0))
            continue
        if distance >= opaque_threshold:
            output.append((red, green, blue, 255))
            continue
        alpha = round(255 * (distance - transparent_threshold) / (opaque_threshold - transparent_threshold))
        cleaned_green = min(green, round((red + blue) / 2))
        output.append((red, cleaned_green, blue, alpha))
    result = Image.new("RGBA", image.size)
    result.putdata(output)
    return result


if __name__ == "__main__":
    main()
