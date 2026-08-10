import native from "value-resource.h";

function useResources(): i32 {
  let image = native.z_image_make(40);
  native.z_image_flip(inout image);
  const copied = native.z_image_copy(image);
  const texture = native.z_texture_make(image);
  const systemTexture = native.z_texture_default();
  const width = native.z_image_width(image);
  const copiedWidth = native.z_image_width(copied);
  const textureWidth = native.z_texture_width(texture);
  const systemWidth = native.z_texture_width(systemTexture);
  native.z_image_drop(move copied);
  return width + copiedWidth + textureWidth + systemWidth;
}

function main(): i32 {
  if (native.z_resource_live_count() != 0) return 91;
  const observed = useResources();
  if (native.z_resource_live_count() != 0) return 92;
  return observed;
}
