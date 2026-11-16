// Adapted from el-gladiador/liquid-glass-react, MIT, Copyright (c) 2026 Zaki.
// Local changes: saturation control, neutral tint, sharp edge detail and a
// cheaper chromatic split after a single shared Gaussian evaluation.
// GLSL ES 3.0 (WebGL2) shader sources for the liquid-glass renderer.
//
// Three-layer refraction model (after dashersw/liquid-glass-js):
//   - edge:  exp(-d * edgeDistance)        — bend at the rim
//   - rim:   exp(-d * rimDistance)         — thin refraction lip
//   - base:  1 - exp(-d * baseDistance)    — broad centre warp (glass thickness)
// Plus a corner boost for non-pill/non-circle shapes and an optional
// tangential ripple along the rim.
//
// Background blur is a real 13-tap circular Gaussian sampled in-shader,
// not a mipmap LOD. We still upload mipmaps as a precondition for very
// high-radius blurs (we sample around the LOD that matches the requested
// pixel sigma) but the visible blur quality is the Gaussian on top.
//
// The shape mask + surface normal come from a single rounded-rect SDF.
// Mathematically that already covers circles (radius == half-min) and
// pills (radius == half-height, width > height) — the SDF gradient gives
// the same circular / capsule normals you'd derive analytically.

export const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 a_pos;                 // unit quad: (-1,-1) .. (1,1)
uniform vec4 u_rect;           // xy = top-left (px), zw = size (px)
uniform vec2 u_canvasSize;

out vec2 v_uv;                 // uv into the background texture
out vec2 v_local;              // pixels, centered at element origin
out vec2 v_norm;               // [0,1] across the element

void main() {
  vec2 t = a_pos * 0.5 + 0.5;
  vec2 px = u_rect.xy + t * u_rect.zw;
  vec2 ndc = (px / u_canvasSize) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);

  v_uv = px / u_canvasSize;
  v_local = (t - 0.5) * u_rect.zw;
  v_norm = t;
}
`;

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
in vec2 v_local;
in vec2 v_norm;
out vec4 outColor;

uniform sampler2D u_bg;
uniform vec2 u_canvasSize;
uniform vec4 u_rect;
uniform float u_radius;
uniform float u_surfaceOpacity;
uniform int u_clipCount;
uniform vec4 u_clipRects[8];
uniform float u_clipRadii[8];

uniform float u_refraction;     // edge layer intensity
uniform float u_edgeDistance;
uniform float u_rimIntensity;
uniform float u_rimDistance;
uniform float u_baseIntensity;
uniform float u_baseDistance;
uniform float u_cornerBoost;
uniform float u_ripple;

uniform float u_blur;           // gaussian sigma in pixels
uniform float u_chromatic;
uniform vec3 u_tint;
uniform float u_tintOpacity;
uniform float u_ambientTint;    // 0 or 1
uniform float u_specular;
uniform float u_windowMaterial;
uniform vec2 u_lightDir;
uniform float u_dpr;
uniform float u_saturation;
uniform float u_ior;
uniform float u_fresnel;
uniform float u_edge;
uniform float u_cursor;

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + vec2(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}

// Sample the background with a 13-tap circular Gaussian. \`sigma\` is in
// canvas pixels. We pick a mipmap LOD proportional to the sigma so that
// very large blurs don't undersample the disk — at large sigma the
// mipmap chain has already prefiltered most of the falloff.
vec3 gaussianSample(vec2 uv, float sigma) {
  vec2 texel = 1.0 / u_canvasSize;
  // Spread the 13 ring samples across ~2*sigma, with the centre as the
  // 13th tap. Step = sigma/2 keeps the ring inside the effective support.
  float step = max(sigma * 0.5, 1.0);
  vec2 d = texel * step;
  // Mipmap LOD chosen so that linear filtering between mip levels covers
  // any gaps left by our sparse ring sampling. log2(sigma) maps a 1px
  // sigma to LOD 0, 4px to LOD 2, 16px to LOD 4, etc.
  float lod = max(log2(max(sigma, 1.0)) - 1.0, 0.0);

  // Precomputed normalised 13-tap weights for sigma==step:
  //   centre + 12 ring samples in two concentric rings (8 + 4).
  // Total weights sum to 1.0.
  const float wC = 0.20;
  const float w1 = 0.06;   // inner ring (8 samples, total 0.48)
  const float w2 = 0.08;   // outer ring at 45deg corners (4 samples, total 0.32)

  vec3 c = textureLod(u_bg, uv, lod).rgb * wC;

  // Inner ring (8 axis-aligned + diagonal taps at distance 1)
  c += textureLod(u_bg, uv + vec2( d.x,  0.0), lod).rgb * w1;
  c += textureLod(u_bg, uv + vec2(-d.x,  0.0), lod).rgb * w1;
  c += textureLod(u_bg, uv + vec2( 0.0,  d.y), lod).rgb * w1;
  c += textureLod(u_bg, uv + vec2( 0.0, -d.y), lod).rgb * w1;
  c += textureLod(u_bg, uv + vec2( d.x*0.7,  d.y*0.7), lod).rgb * w1;
  c += textureLod(u_bg, uv + vec2(-d.x*0.7,  d.y*0.7), lod).rgb * w1;
  c += textureLod(u_bg, uv + vec2( d.x*0.7, -d.y*0.7), lod).rgb * w1;
  c += textureLod(u_bg, uv + vec2(-d.x*0.7, -d.y*0.7), lod).rgb * w1;

  // Outer ring at distance ~2 along diagonals
  c += textureLod(u_bg, uv + vec2( d.x*1.7,  d.y*1.7), lod).rgb * w2;
  c += textureLod(u_bg, uv + vec2(-d.x*1.7,  d.y*1.7), lod).rgb * w2;
  c += textureLod(u_bg, uv + vec2( d.x*1.7, -d.y*1.7), lod).rgb * w2;
  c += textureLod(u_bg, uv + vec2(-d.x*1.7, -d.y*1.7), lod).rgb * w2;

  return c;
}

// "Ambient" tint — sample a wide horizontal band of the background
// above and below the glass element, average it down, and use it as
// a vertical gradient tint mixed into the result. This is what gives
// Apple's glass its "I picked up the colour of the room" feel.
vec3 ambientGradient(float vNorm) {
  vec2 rectMin = u_rect.xy / u_canvasSize;
  vec2 rectSize = u_rect.zw / u_canvasSize;
  // Bands at element top, middle and bottom, extended outside the
  // element by ~50% of its height to gather surrounding context.
  float yTop = rectMin.y - rectSize.y * 0.4;
  float yMid = rectMin.y + rectSize.y * 0.5;
  float yBot = rectMin.y + rectSize.y * 1.4;

  // Sample 8 horizontal positions across the canvas at each band, at a
  // high mip level so each tap already represents a wide average.
  const float lod = 5.0;
  vec3 top = vec3(0.0), mid = vec3(0.0), bot = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float fx = (float(i) + 0.5) / 8.0;
    top += textureLod(u_bg, vec2(fx, clamp(yTop, 0.0, 1.0)), lod).rgb;
    mid += textureLod(u_bg, vec2(fx, clamp(yMid, 0.0, 1.0)), lod).rgb;
    bot += textureLod(u_bg, vec2(fx, clamp(yBot, 0.0, 1.0)), lod).rgb;
  }
  top /= 8.0; mid /= 8.0; bot /= 8.0;

  if (vNorm < 0.5) return mix(top, mid, vNorm * 2.0);
  return mix(mid, bot, (vNorm - 0.5) * 2.0);
}

void main() {
  vec2 halfSize = u_rect.zw * 0.5;
  float r = clamp(u_radius, 0.0, min(halfSize.x, halfSize.y));

  float d = sdRoundedBox(v_local, halfSize, r);
  if (d > 1.0) discard;

  // Outward normal via SDF gradient. For circles/pills the SDF reduces
  // to the analytical capsule/circle SDF, so this also produces the
  // correct shape-aware normal for those.
  float eps = 1.0;
  vec2 grad = vec2(
    sdRoundedBox(v_local + vec2(eps, 0.0), halfSize, r) -
    sdRoundedBox(v_local - vec2(eps, 0.0), halfSize, r),
    sdRoundedBox(v_local + vec2(0.0, eps), halfSize, r) -
    sdRoundedBox(v_local - vec2(0.0, eps), halfSize, r)
  );
  float gLen = length(grad);
  vec2 normal = gLen > 1e-5 ? grad / gLen : vec2(0.0, -1.0);

  // Inward depth from the rim, in canvas pixels.
  float depth = max(0.0, -d);

  // Three-layer refraction profile.
  float edge = exp(-depth * u_edgeDistance);
  float rim  = exp(-depth * u_rimDistance);
  float base = 1.0 - exp(-depth * u_baseDistance);
  float refractAmt = edge * u_refraction
                   + rim  * u_rimIntensity
                   + base * u_baseIntensity;

  float scale = min(u_rect.z, u_rect.w);
  vec2 uvOffset = -normal * refractAmt * scale / u_canvasSize;

  // Corner boost — extra refraction toward rectangle corners.
  if (u_cornerBoost > 0.001) {
    vec2 toCorner = abs(v_local) - (halfSize - vec2(r));
    float cornerProx = length(max(toCorner, vec2(0.0)));
    float boost = exp(-cornerProx * 0.15) * u_cornerBoost;
    uvOffset += -normal * boost * scale / u_canvasSize;
  }

  // Tangential ripple along the rim.
  if (u_ripple > 0.001) {
    vec2 perp = vec2(-normal.y, normal.x);
    float ripple = sin(depth * 0.4) * rim * u_ripple;
    uvOffset += perp * ripple * scale / u_canvasSize;
  }

  // Sigma scales with the rim layer so the rim reads as a frosted
  // bevel even when the centre stays mostly clear.
  float sigma = u_blur * (1.0 + rim * 1.5);

  vec3 col = gaussianSample(v_uv + uvOffset, sigma);
  if (u_chromatic > 0.001) {
    vec2 caOff = -normal * (u_chromatic * (edge * u_refraction + rim * u_rimIntensity) * 0.5)
                 * scale / u_canvasSize;
    vec3 split = vec3(texture(u_bg,v_uv+uvOffset+caOff).r,texture(u_bg,v_uv+uvOffset).g,texture(u_bg,v_uv+uvOffset-caOff).b);
    col = mix(col, split, edge * 0.28);
  }
  float luma = dot(col, vec3(0.2126,0.7152,0.0722));
  col = mix(vec3(luma),col,u_saturation);

  // Vertical-gradient tint (Apple-style top-brighter, bottom-darker).
  vec3 vGrad = mix(vec3(1.0), vec3(0.98), v_norm.y);
  vec3 environmentTint = textureLod(u_bg, vec2(0.5), 8.0).rgb;
  col = mix(col, mix(environmentTint, u_tint, 0.22) * vGrad, u_tintOpacity);

  // Ambient sampled-gradient tint — picks up dominant background colour.
  if (u_ambientTint > 0.5) {
    vec3 amb = ambientGradient(v_norm.y);
    col = mix(col, amb, u_tintOpacity * 0.4);
  }

  // Solid tint colour mixed in lightly on top.
  col = mix(col, u_tint, u_tintOpacity * 0.08);

  if (u_windowMaterial > 0.5) {
    // The full-window bevel has one soft reflection around all four sides.
    // Start inside the cutout, leaving its outermost pixel free of a stroke.
    float bevel = smoothstep(1.0 * u_dpr, 3.5 * u_dpr, depth) *
                  (1.0 - smoothstep(6.0 * u_dpr, 15.0 * u_dpr, depth));
    col += vec3(bevel * u_specular * (0.055 + u_fresnel * 0.03 + u_edge * 0.018));
  } else {
  // Smaller surfaces retain their directional specular lighting.
  if (u_specular > 0.001) {
    float ndl = max(0.0, dot(normal, normalize(mix(vec2(-.6,-.8),u_lightDir,u_cursor))));
    float rimBand = smoothstep(0.0, 2.0 * u_dpr, depth) *
                    (1.0 - smoothstep(2.0 * u_dpr, 8.0 * u_dpr, depth));
    vec2 lightAnchor = clamp(vec2(0.5) + u_lightDir * 0.38, vec2(0.08), vec2(0.92));
    vec2 fromLight = v_norm - lightAnchor;
    float focus = 0.16 + 0.84 * exp(-dot(fromLight,fromLight) * 5.5);
    float glow = pow(ndl, 4.0) * rimBand * u_specular * focus;
    col += vec3(glow) * 1.2;

    // Subtle inner rim sheen — a continuous luminous band along the
    // very rim, independent of light direction. This is the "always on"
    // edge highlight that reads as glass.
    float sheen = exp(-depth * 0.25) * rim * 0.18 * u_specular;
    col += vec3(sheen);
  }

  // Schlick reflectance for the apparent rounded surface, not the flat DOM plane.
  float slope = exp(-depth / (4.0 * u_dpr));
  float cosView = sqrt(max(0.0, 1.0 - slope * slope));
  float f0 = pow((u_ior - 1.0) / (u_ior + 1.0), 2.0);
  float reflectance = f0 + (1.0 - f0) * pow(1.0 - cosView, 5.0);
  float directional = .18 + .82 * max(0.0,dot(normal,u_lightDir));
  col += vec3(reflectance * slope * u_fresnel * directional * .3);
  col += vec3(exp(-depth / u_dpr) * u_edge * directional * .12);
  }
  float aaWidth = max(fwidth(d) * 1.2, u_dpr * 1.25);
  float alpha = clamp(0.5 - d / aaWidth, 0.0, 1.0);
  // A shared framebuffer does not inherit CSS overflow or ancestor opacity.
  // Apply those masks explicitly so scrolled glass cannot escape its panel.
  for (int i = 0; i < 8; i++) {
    if (i >= u_clipCount) break;
    vec4 clipRect = u_clipRects[i];
    vec2 clipHalf = clipRect.zw * 0.5;
    vec2 clipLocal = v_uv * u_canvasSize - clipRect.xy - clipHalf;
    float clipRadius = clamp(u_clipRadii[i], 0.0, min(clipHalf.x, clipHalf.y));
    float clipDistance = sdRoundedBox(clipLocal, clipHalf, clipRadius);
    alpha *= clamp(0.5 - clipDistance / aaWidth, 0.0, 1.0);
  }
  alpha *= u_surfaceOpacity;

  outColor = vec4(col * alpha, alpha);
}
`;
