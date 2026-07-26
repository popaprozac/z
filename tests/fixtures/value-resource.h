#ifndef Z_VALUE_RESOURCE_H
#define Z_VALUE_RESOURCE_H

#include <stdlib.h>

typedef struct ZImage {
  void *data;
  int width;
} ZImage;

typedef struct ZTexture {
  unsigned int id;
  int width;
} ZTexture;

typedef ZTexture ZTexture2D;
typedef ZTexture ZTextureCubemap;

static int z_resource_image_live = 0;
static int z_resource_texture_live = 0;
static unsigned int z_resource_next_texture = 1;

static inline ZImage z_image_make(int width) {
  ZImage image = { malloc(1), width };
  if (image.data != NULL) z_resource_image_live += 1;
  return image;
}

static inline ZImage z_image_copy(ZImage image) {
  return z_image_make(image.width);
}

static inline int z_image_width(ZImage image) {
  return image.width;
}

static inline void z_image_flip(ZImage *image) {
  image->width += 1;
}

static inline void z_image_drop(ZImage image) {
  if (image.data != NULL) {
    free(image.data);
    z_resource_image_live -= 1;
  }
}

static inline ZTexture2D z_texture_make(ZImage image) {
  ZTexture2D texture = { z_resource_next_texture++, image.width };
  z_resource_texture_live += 1;
  return texture;
}

static inline ZTexture2D z_texture_default(void) {
  ZTexture2D texture = { 999U, 1 };
  return texture;
}

static inline int z_texture_width(ZTexture2D texture) {
  return texture.width;
}

static inline void z_texture_drop(ZTexture2D texture) {
  if (texture.id != 999U) z_resource_texture_live -= 1;
}

static inline int z_resource_live_count(void) {
  return z_resource_image_live + z_resource_texture_live;
}

#endif
