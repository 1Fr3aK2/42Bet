
import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { Logger } from '@nestjs/common';

const logger = new Logger('Avatar');
const MAX_AVATAR_BYTES = 75 * 1024;
const MAX_AVATAR_PIXELS = 16_000_000;
const MAX_DIMENSION = 4096;

const MIME_FORMATS: Record<string, string> = {
  png: 'png',
  jpeg: 'jpeg',
  webp: 'webp',
  gif: 'gif',
};

const DATA_URL_REGEX =
  /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

export async function normalizeAvatar(
  avatar: string | null | undefined,
): Promise<string | null | undefined> {
  if (avatar === undefined || avatar === null) {
    return avatar;
  }

  const match = DATA_URL_REGEX.exec(avatar);

  if (!match) {
    throw new BadRequestException('Invalid avatar format');
  }

  const declaredFormat = MIME_FORMATS[match[1]];
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');

  if (
    buffer.length === 0 ||
    buffer.length > MAX_AVATAR_BYTES ||
    buffer.toString('base64') !== base64
  ) {
    throw new BadRequestException('Invalid avatar data');
  }

  try {
    const image = sharp(buffer, {
      failOn: 'error',
      limitInputPixels: MAX_AVATAR_PIXELS,
    });

    const metadata = await image.metadata();

    if (
      metadata.format !== declaredFormat ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_DIMENSION ||
      metadata.height > MAX_DIMENSION ||
      metadata.width * metadata.height > MAX_AVATAR_PIXELS
    ) {
      throw new BadRequestException('Invalid avatar image');
    }

    const output = await image
      .rotate()
      .resize(256, 256, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();

    return `data:image/jpeg;base64,${output.toString('base64')}`;

  } catch (error) {
    if (error instanceof BadRequestException) {
      throw error;
    }

    logger.error(
      'Avatar processing failed',
      error instanceof Error ? error.stack : String(error),
    );

    throw new BadRequestException(
      'Avatar must contain a valid image',
    );
  }
}
