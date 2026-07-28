/**
 * Liquid Glass 液态玻璃效果 - WebGL 版
 * 替换旧的 SVG backdrop-filter 方案
 * 使用 Three.js ShaderMaterial 渲染
 */
(function () {
    'use strict';

    // ================================================================
    // 配置参数
    // ================================================================
    var CFG = {
        radius: 35,      // 圆角半径
        bezel: 55,       // 边框宽度
        thick: 129,      // 玻璃厚度
        ior: 3.0,        // 折射率
        blur: 8.0,       // 模糊度
        spec: 0.40,      // 高光强度
        tint: 0.21,      // 白色染色
        tintColor: '#ffffff', // 染色颜色（十六进制，默认白色）
        shadow: 0.15,    // 阴影强度
        pixelRatio: 2,
    };

    // ================================================================
    // 卡片选择器
    // ================================================================
    var CARD_SELECTORS = [
        '#recent-posts > .recent-post-item',
        '#aside-content .card-widget',
        '.layout > div:first-child:not(.recent-posts)',
        '#footer-wrap',
    ];

    // 导航栏保持原有的 CSS 渐变 + backdrop-filter 模糊
    // 已经恢复为原来的样式

    // ================================================================
    // 状态
    // ================================================================
    var renderer = null;
    var scene = null;
    var camera = null;
    var cards = [];
    var bgTexture = null;
    var initialized = false;
    var rafId = null;
    var checkTimer = null;

    // ================================================================
    // Shaders — 加入 tintColor uniform
    // ================================================================
    var vertexShader = [
        'varying vec2 vUv;',
        'void main() {',
        '  vUv = uv;',
        '  gl_Position = vec4(position, 1.0);',
        '}'
    ].join('\n');

    // 解析十六进制颜色为 vec3
    function hexToVec3(hex) {
        var r = parseInt(hex.slice(1,3), 16) / 255;
        var g = parseInt(hex.slice(3,5), 16) / 255;
        var b = parseInt(hex.slice(5,7), 16) / 255;
        return { r: r, g: g, b: b };
    }

    var fragmentShader = [
        'precision highp float;',
        'varying vec2 vUv;',
        '',
        'uniform vec2 uResolution;',
        'uniform vec2 uGlassCenter;',
        'uniform vec2 uGlassSize;',
        'uniform float uRadius;',
        'uniform float uBezel;',
        'uniform float uThickness;',
        'uniform float uIOR;',
        'uniform float uBlur;',
        'uniform float uSpecular;',
        'uniform float uTint;',
        'uniform vec3 uTintColor;',
        'uniform float uShadow;',
        'uniform sampler2D uBgTex;',
        'uniform float uBgAspect;',
        '',
        'float sdRoundedRect(vec2 p, vec2 halfSize, float r) {',
        '  vec2 q = abs(p) - halfSize + r;',
        '  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;',
        '}',
        '',
        'float surfaceHeight(float t) {',
        '  float s = 1.0 - t;',
        '  return pow(1.0 - s * s * s * s, 0.25);',
        '}',
        '',
        'vec3 sampleBg(vec2 screenUV) {',
        '  float screenAspect = uResolution.x / uResolution.y;',
        '  vec2 uv = screenUV;',
        '  if (uBgAspect > screenAspect) {',
        '    float s = screenAspect / uBgAspect;',
        '    uv.x = uv.x * s + (1.0 - s) * 0.5;',
        '  } else {',
        '    float s = uBgAspect / screenAspect;',
        '    uv.y = uv.y * s + (1.0 - s) * 0.5;',
        '  }',
        '  uv.y = 1.0 - uv.y;',
        '  return texture2D(uBgTex, uv).rgb;',
        '}',
        '',
        'vec3 sampleBgBlurred(vec2 uv, float radius) {',
        '  if (radius < 0.5) return sampleBg(uv);',
        '  vec3 sum = vec3(0.0);',
        '  vec2 px = 1.0 / uResolution;',
        '  vec2 offsets[16];',
        '  offsets[0]  = vec2(-0.94201, -0.39906);',
        '  offsets[1]  = vec2( 0.94558, -0.76890);',
        '  offsets[2]  = vec2(-0.09418, -0.92938);',
        '  offsets[3]  = vec2( 0.34495,  0.29387);',
        '  offsets[4]  = vec2(-0.91588, -0.45771);',
        '  offsets[5]  = vec2(-0.81544,  0.48568);',
        '  offsets[6]  = vec2(-0.38277, -0.56071);',
        '  offsets[7]  = vec2(-0.12675,  0.84686);',
        '  offsets[8]  = vec2( 0.89642,  0.41254);',
        '  offsets[9]  = vec2( 0.18150, -0.30020);',
        '  offsets[10] = vec2(-0.01445, -0.16001);',
        '  offsets[11] = vec2( 0.59614,  0.71118);',
        '  offsets[12] = vec2( 0.49742, -0.47280);',
        '  offsets[13] = vec2( 0.80685,  0.04588);',
        '  offsets[14] = vec2(-0.32490, -0.03965);',
        '  offsets[15] = vec2(-0.60975,  0.06566);',
        '  for (int i = 0; i < 16; i++) {',
        '    sum += sampleBg(uv + offsets[i] * radius * px);',
        '  }',
        '  return sum / 16.0;',
        '}',
        '',
        'void main() {',
        '  vec2 screenPx = vec2(vUv.x, 1.0 - vUv.y) * uResolution;',
        '  vec2 p = screenPx - uGlassCenter;',
        '  vec2 halfSize = uGlassSize * 0.5;',
        '  float sd = sdRoundedRect(p, halfSize, uRadius);',
        '',
        '  if (sd > 0.0) {',
        '    float shadowFalloff = exp(-sd * sd / 800.0);',
        '    float shadowAlpha = uShadow * shadowFalloff * 0.6;',
        '    gl_FragColor = vec4(0.0, 0.0, 0.0, shadowAlpha);',
        '    return;',
        '  }',
        '',
        '  float distFromEdge = -sd;',
        '  float bezel = min(uBezel, min(uRadius, min(halfSize.x, halfSize.y)) - 1.0);',
        '  float t = clamp(distFromEdge / bezel, 0.0, 1.0);',
        '  float h = surfaceHeight(t);',
        '  float dt = 0.001;',
        '  float h2 = surfaceHeight(min(t + dt, 1.0));',
        '  float dh = (h2 - h) / dt;',
        '  float slopeAngle = atan(dh * (uThickness / bezel));',
        '  float sinR = sin(slopeAngle) / uIOR;',
        '  sinR = clamp(sinR, -1.0, 1.0);',
        '  float thetaR = asin(sinR);',
        '  float displacement = h * uThickness * (tan(slopeAngle) - tan(thetaR));',
        '',
        '  vec2 grad;',
        '  float eps = 0.5;',
        '  grad.x = sdRoundedRect(p + vec2(eps, 0.0), halfSize, uRadius) - sd;',
        '  grad.y = sdRoundedRect(p + vec2(0.0, eps), halfSize, uRadius) - sd;',
        '  grad = normalize(grad);',
        '',
        '  vec2 offset = -grad * displacement / uResolution;',
        '  vec2 screenUV = screenPx / uResolution;',
        '  vec2 refractedUV = screenUV + offset;',
        '  vec3 color = sampleBgBlurred(refractedUV, uBlur);',
        '',
        '  vec2 lightDir = normalize(vec2(0.5, -0.7));',
        '  float rimDot = abs(dot(grad, lightDir));',
        '  float rimFalloff = 1.0 - smoothstep(0.0, bezel * 0.4, distFromEdge);',
        '  float specHighlight = pow(rimDot * rimFalloff, 1.5);',
        '  color += vec3(specHighlight * uSpecular);',
        '',
        '  float innerShadow = 1.0 - smoothstep(0.0, bezel * 0.6, distFromEdge);',
        '  color *= mix(1.0, 0.7, innerShadow * 0.3);',
        '',
        '  float innerRim = smoothstep(0.0, 2.0, distFromEdge) * (1.0 - smoothstep(2.0, 5.0, distFromEdge));',
        '  color += vec3(innerRim * 0.15 * uSpecular);',
        '',
        '  color = mix(color, uTintColor, uTint);',
        '',
        '  float alpha = smoothstep(0.0, 1.5, distFromEdge);',
        '  gl_FragColor = vec4(color, alpha);',
        '}'
    ].join('\n');

    // ================================================================
    // Three.js 初始化
    // ================================================================
    function initThree() {
        if (initialized) return;
        var canvas = document.createElement('canvas');
        canvas.id = 'liquid-glass-canvas';
        canvas.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;width:100vw;height:100vh;';
        document.body.insertAdjacentElement('afterbegin', canvas);

        renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, CFG.pixelRatio));
        renderer.setSize(window.innerWidth, window.innerHeight);

        scene = new THREE.Scene();
        camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        initialized = true;
    }

    // ================================================================
    // 背景纹理
    // ================================================================
    function getBgImageUrl() {
        var wrap = document.getElementById('body-wrap');
        if (wrap) {
            var cs = window.getComputedStyle(wrap);
            var bgImg = cs.backgroundImage;
            if (bgImg && bgImg !== 'none') {
                var m = bgImg.match(/url\(["']?([^"')]+)["']?\)/);
                if (m) return m[1];
            }
        }
        var bg = document.body;
        var cs = window.getComputedStyle(bg);
        var bgImg = cs.backgroundImage;
        if (bgImg && bgImg !== 'none') {
            var m = bgImg.match(/url\(["']?([^"')]+)["']?\)/);
            if (m) return m[1];
        }
        return null;
    }

    function loadBgTexture(url) {
        if (!url) return;
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
            var tex = new THREE.Texture(img);
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.needsUpdate = true;
            bgTexture = tex;
            for (var k = 0; k < cards.length; k++) {
                cards[k].mat.uniforms.uBgTex.value = tex;
                cards[k].mat.uniforms.uBgAspect.value = img.naturalWidth / img.naturalHeight;
            }
        };
        img.src = url;
    }

    // ================================================================
    // 卡片管理
    // ================================================================
    function getCardElements() {
        var results = [];
        for (var s = 0; s < CARD_SELECTORS.length; s++) {
            var els = document.querySelectorAll(CARD_SELECTORS[s]);
            for (var i = 0; i < els.length; i++) results.push(els[i]);
        }
        return results;
    }

    function getCardRadius(el) {
        var cs = window.getComputedStyle(el);
        var br = cs.borderRadius;
        if (br) {
            var num = parseFloat(br);
            if (!isNaN(num) && num > 0) return num;
        }
        return CFG.radius;
    }

    var _tintColor = hexToVec3(CFG.tintColor);

    function createCardMesh(el) {
        var rect = el.getBoundingClientRect();
        var w = Math.round(rect.width);
        var h = Math.round(rect.height);
        if (w < 10 || h < 10) return null;

        var mat = new THREE.ShaderMaterial({
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            uniforms: {
                uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
                uGlassCenter: { value: new THREE.Vector2(0, 0) },
                uGlassSize: { value: new THREE.Vector2(w, h) },
                uRadius: { value: getCardRadius(el) },
                uBezel: { value: CFG.bezel },
                uThickness: { value: CFG.thick },
                uIOR: { value: CFG.ior },
                uBlur: { value: CFG.blur },
                uSpecular: { value: CFG.spec },
                uTint: { value: CFG.tint },
                uTintColor: { value: new THREE.Vector3(_tintColor.r, _tintColor.g, _tintColor.b) },
                uShadow: { value: CFG.shadow },
                uBgTex: { value: bgTexture },
                uBgAspect: { value: bgTexture ? bgTexture.image.width / bgTexture.image.height : 1.5 },
            },
            transparent: true,
            depthTest: false,
            depthWrite: false,
        });

        var mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
        scene.add(mesh);
        return { el: el, mesh: mesh, mat: mat, w: w, h: h };
    }

    function refreshCards() {
        var elements = getCardElements();
        var newCards = [];
        for (var i = 0; i < cards.length; i++) {
            var found = false;
            for (var j = 0; j < elements.length; j++) {
                if (cards[i].el === elements[j]) { found = true; break; }
            }
            if (found) newCards.push(cards[i]);
            else { scene.remove(cards[i].mesh); cards[i].mat.dispose(); }
        }
        cards = newCards;

        for (var j = 0; j < elements.length; j++) {
            var el = elements[j], exists = false;
            for (var i = 0; i < cards.length; i++) {
                if (cards[i].el === el) { exists = true; break; }
            }
            if (!exists) {
                var card = createCardMesh(el);
                if (card) cards.push(card);
            }
        }

        cards.sort(function (a, b) {
            var ra = a.el.getBoundingClientRect();
            var rb = b.el.getBoundingClientRect();
            return ra.top - rb.top;
        });
        for (var i = 0; i < cards.length; i++) cards[i].mesh.renderOrder = i;
    }

    // ================================================================
    // 渲染循环
    // ================================================================
    function render() {
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var res = new THREE.Vector2(vw, vh);

        for (var k = 0; k < cards.length; k++) {
            var c = cards[k];
            var rect = c.el.getBoundingClientRect();
            var rw = Math.round(rect.width);
            var rh = Math.round(rect.height);
            var u = c.mat.uniforms;

            u.uResolution.value.copy(res);
            u.uGlassCenter.value.set(rect.left + rw / 2, rect.top + rh / 2);
            u.uGlassSize.value.set(rw, rh);

            u.uRadius.value = getCardRadius(c.el);
            u.uBezel.value = CFG.bezel;
            u.uThickness.value = CFG.thick;
            u.uIOR.value = CFG.ior;
            u.uBlur.value = CFG.blur;
            u.uSpecular.value = CFG.spec;
            u.uTint.value = CFG.tint;
            u.uTintColor.value.set(_tintColor.r, _tintColor.g, _tintColor.b);
            u.uShadow.value = CFG.shadow;
        }

        renderer.render(scene, camera);
        rafId = requestAnimationFrame(render);
    }

    // ================================================================
    // 启动
    // ================================================================
    function start() {
        if (typeof THREE === 'undefined') {
            setTimeout(start, 200);
            return;
        }
        initThree();
        var bgUrl = getBgImageUrl();
        if (bgUrl) loadBgTexture(bgUrl);
        refreshCards();
        // 持续检查直到有卡片 — 防止 footer 等元素初始尺寸为 0
        if (cards.length === 0) {
            checkTimer = setTimeout(start, 300);
            return;
        } else {
            // 如果有 0 尺寸的卡片，持续重试
            var hasZero = false;
            for (var i = 0; i < cards.length; i++) {
                if (cards[i].w < 10 || cards[i].h < 10) { hasZero = true; break; }
            }
            if (hasZero) {
                setTimeout(function() { refreshCards(); }, 500);
            }
        }
        render();
    }

    var refreshTimer = null;
    function scheduleRefresh() {
        if (refreshTimer) return;
        refreshTimer = setTimeout(function() { refreshTimer = null; refreshCards(); }, 200);
    }

    window.addEventListener('resize', function() {
        if (renderer) renderer.setSize(window.innerWidth, window.innerHeight);
        scheduleRefresh();
    });

    var observer = null;
    function setupObserver() {
        if (observer) return;
        observer = new MutationObserver(function() { scheduleRefresh(); });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { start(); setupObserver(); });
    } else {
        start();
        setupObserver();
    }

    document.addEventListener('pjax:complete', function() { setTimeout(start, 300); });

    console.log('[Liquid Glass WebGL] Initialized');
})();
