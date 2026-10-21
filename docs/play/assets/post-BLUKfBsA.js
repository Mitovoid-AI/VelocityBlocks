var F=Object.defineProperty;var N=(l,e,i)=>e in l?F(l,e,{enumerable:!0,configurable:!0,writable:!0,value:i}):l[e]=i;var f=(l,e,i)=>N(l,typeof e!="symbol"?e+"":e,i);import{z as y,W as U,B as A,aO as S,aP as x,aQ as R,a5 as B,aR as E,aS as D,aT as O,aU as I,aV as z,aW as G,aX as V,aY as Q,C,V as n,aZ as v,aD as T,a_ as d,e as p,a$ as H,v as L}from"./index-CZdIrca4.js";class P{constructor(){this.isPass=!0,this.enabled=!0,this.needsSwap=!0,this.clear=!1,this.renderToScreen=!1}setSize(){}render(){console.error("THREE.Pass: .render() must be implemented in derived pass.")}dispose(){}}const W=new U(-1,1,1,-1,0,1);class X extends A{constructor(){super(),this.setAttribute("position",new S([-1,3,0,-1,-1,0,3,-1,0],3)),this.setAttribute("uv",new S([0,2,0,0,2,0],2))}}const j=new X;class w{constructor(e){this._mesh=new y(j,e)}dispose(){this._mesh.geometry.dispose()}render(e){e.render(this._mesh,W)}get material(){return this._mesh.material}set material(e){this._mesh.material=e}}const c={name:"OutputShader",uniforms:{tDiffuse:{value:null},toneMappingExposure:{value:1}},vertexShader:`
		precision highp float;

		uniform mat4 modelViewMatrix;
		uniform mat4 projectionMatrix;

		attribute vec3 position;
		attribute vec2 uv;

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		precision highp float;

		uniform sampler2D tDiffuse;

		#include <tonemapping_pars_fragment>
		#include <colorspace_pars_fragment>

		varying vec2 vUv;

		void main() {

			gl_FragColor = texture2D( tDiffuse, vUv );

			// tone mapping

			#ifdef LINEAR_TONE_MAPPING

				gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );

			#elif defined( REINHARD_TONE_MAPPING )

				gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );

			#elif defined( CINEON_TONE_MAPPING )

				gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );

			#elif defined( ACES_FILMIC_TONE_MAPPING )

				gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );

			#elif defined( AGX_TONE_MAPPING )

				gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );

			#elif defined( NEUTRAL_TONE_MAPPING )

				gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );

			#elif defined( CUSTOM_TONE_MAPPING )

				gl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );

			#endif

			// color space

			#ifdef SRGB_TRANSFER

				gl_FragColor = sRGBTransferOETF( gl_FragColor );

			#endif

		}`};class K extends P{constructor(){super(),this.isOutputPass=!0,this.uniforms=x.clone(c.uniforms),this.material=new R({name:c.name,uniforms:this.uniforms,vertexShader:c.vertexShader,fragmentShader:c.fragmentShader}),this._fsQuad=new w(this.material),this._outputColorSpace=null,this._toneMapping=null}render(e,i,t){this.uniforms.tDiffuse.value=t.texture,this.uniforms.toneMappingExposure.value=e.toneMappingExposure,(this._outputColorSpace!==e.outputColorSpace||this._toneMapping!==e.toneMapping)&&(this._outputColorSpace=e.outputColorSpace,this._toneMapping=e.toneMapping,this.material.defines={},B.getTransfer(this._outputColorSpace)===E&&(this.material.defines.SRGB_TRANSFER=""),this._toneMapping===D?this.material.defines.LINEAR_TONE_MAPPING="":this._toneMapping===O?this.material.defines.REINHARD_TONE_MAPPING="":this._toneMapping===I?this.material.defines.CINEON_TONE_MAPPING="":this._toneMapping===z?this.material.defines.ACES_FILMIC_TONE_MAPPING="":this._toneMapping===G?this.material.defines.AGX_TONE_MAPPING="":this._toneMapping===V?this.material.defines.NEUTRAL_TONE_MAPPING="":this._toneMapping===Q&&(this.material.defines.CUSTOM_TONE_MAPPING=""),this.material.needsUpdate=!0),this.renderToScreen===!0?(e.setRenderTarget(null),this._fsQuad.render(e)):(e.setRenderTarget(i),this.clear&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil),this._fsQuad.render(e))}dispose(){this.material.dispose(),this._fsQuad.dispose()}}const _={uniforms:{tDiffuse:{value:null},opacity:{value:1}},vertexShader:`

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		uniform float opacity;

		uniform sampler2D tDiffuse;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );
			gl_FragColor = opacity * texel;


		}`},Y={uniforms:{tDiffuse:{value:null},luminosityThreshold:{value:1},smoothWidth:{value:1},defaultColor:{value:new C(0)},defaultOpacity:{value:0}},vertexShader:`

		varying vec2 vUv;

		void main() {

			vUv = uv;

			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		uniform sampler2D tDiffuse;
		uniform vec3 defaultColor;
		uniform float defaultOpacity;
		uniform float luminosityThreshold;
		uniform float smoothWidth;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );

			float v = luminance( texel.xyz );

			vec4 outputColor = vec4( defaultColor.rgb, defaultOpacity );

			float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );

			gl_FragColor = mix( outputColor, texel, alpha );

		}`};class m extends P{constructor(e,i=1,t,s){super(),this.strength=i,this.radius=t,this.threshold=s,this.resolution=e!==void 0?new n(e.x,e.y):new n(256,256),this.clearColor=new C(0,0,0),this.needsSwap=!1,this.renderTargetsHorizontal=[],this.renderTargetsVertical=[],this.nMips=5;let r=Math.round(this.resolution.x/2),a=Math.round(this.resolution.y/2);this.renderTargetBright=new v(r,a,{type:T,depthBuffer:!1}),this.renderTargetBright.texture.name="UnrealBloomPass.bright",this.renderTargetBright.texture.generateMipmaps=!1;for(let h=0;h<this.nMips;h++){const M=new v(r,a,{type:T,depthBuffer:!1});M.texture.name="UnrealBloomPass.h"+h,M.texture.generateMipmaps=!1,this.renderTargetsHorizontal.push(M);const b=new v(r,a,{type:T,depthBuffer:!1});b.texture.name="UnrealBloomPass.v"+h,b.texture.generateMipmaps=!1,this.renderTargetsVertical.push(b),r=Math.round(r/2),a=Math.round(a/2)}const u=Y;this.highPassUniforms=x.clone(u.uniforms),this.highPassUniforms.luminosityThreshold.value=s,this.highPassUniforms.smoothWidth.value=.01,this.materialHighPassFilter=new d({uniforms:this.highPassUniforms,vertexShader:u.vertexShader,fragmentShader:u.fragmentShader}),this.separableBlurMaterials=[];const o=[6,10,14,18,22];r=Math.round(this.resolution.x/2),a=Math.round(this.resolution.y/2);for(let h=0;h<this.nMips;h++)this.separableBlurMaterials.push(this._getSeparableBlurMaterial(o[h])),this.separableBlurMaterials[h].uniforms.invSize.value=new n(1/r,1/a),r=Math.round(r/2),a=Math.round(a/2);this.compositeMaterial=this._getCompositeMaterial(this.nMips),this.compositeMaterial.uniforms.blurTexture1.value=this.renderTargetsVertical[0].texture,this.compositeMaterial.uniforms.blurTexture2.value=this.renderTargetsVertical[1].texture,this.compositeMaterial.uniforms.blurTexture3.value=this.renderTargetsVertical[2].texture,this.compositeMaterial.uniforms.blurTexture4.value=this.renderTargetsVertical[3].texture,this.compositeMaterial.uniforms.blurTexture5.value=this.renderTargetsVertical[4].texture,this.compositeMaterial.uniforms.bloomStrength.value=i,this.compositeMaterial.uniforms.bloomRadius.value=.1;const g=[1,.8,.6,.4,.2];this.compositeMaterial.uniforms.bloomFactors.value=g,this.bloomTintColors=[new p(1,1,1),new p(1,1,1),new p(1,1,1),new p(1,1,1),new p(1,1,1)],this.compositeMaterial.uniforms.bloomTintColors.value=this.bloomTintColors,this.copyUniforms=x.clone(_.uniforms),this.blendMaterial=new d({uniforms:this.copyUniforms,vertexShader:_.vertexShader,fragmentShader:_.fragmentShader,premultipliedAlpha:!0,blending:H,depthTest:!1,depthWrite:!1,transparent:!0}),this._oldClearColor=new C,this._oldClearAlpha=1,this._basic=new L,this._fsQuad=new w(null)}dispose(){for(let e=0;e<this.renderTargetsHorizontal.length;e++)this.renderTargetsHorizontal[e].dispose();for(let e=0;e<this.renderTargetsVertical.length;e++)this.renderTargetsVertical[e].dispose();this.renderTargetBright.dispose();for(let e=0;e<this.separableBlurMaterials.length;e++)this.separableBlurMaterials[e].dispose();this.compositeMaterial.dispose(),this.blendMaterial.dispose(),this._basic.dispose(),this._fsQuad.dispose()}setSize(e,i){let t=Math.round(e/2),s=Math.round(i/2);this.renderTargetBright.setSize(t,s);for(let r=0;r<this.nMips;r++)this.renderTargetsHorizontal[r].setSize(t,s),this.renderTargetsVertical[r].setSize(t,s),this.separableBlurMaterials[r].uniforms.invSize.value=new n(1/t,1/s),t=Math.round(t/2),s=Math.round(s/2)}render(e,i,t,s,r){e.getClearColor(this._oldClearColor),this._oldClearAlpha=e.getClearAlpha();const a=e.autoClear;e.autoClear=!1,e.setClearColor(this.clearColor,0),r&&e.state.buffers.stencil.setTest(!1),this.renderToScreen&&(this._fsQuad.material=this._basic,this._basic.map=t.texture,e.setRenderTarget(null),e.clear(),this._fsQuad.render(e)),this.highPassUniforms.tDiffuse.value=t.texture,this.highPassUniforms.luminosityThreshold.value=this.threshold,this._fsQuad.material=this.materialHighPassFilter,e.setRenderTarget(this.renderTargetBright),e.clear(),this._fsQuad.render(e);let u=this.renderTargetBright;for(let o=0;o<this.nMips;o++)this._fsQuad.material=this.separableBlurMaterials[o],this.separableBlurMaterials[o].uniforms.colorTexture.value=u.texture,this.separableBlurMaterials[o].uniforms.direction.value=m.BlurDirectionX,e.setRenderTarget(this.renderTargetsHorizontal[o]),e.clear(),this._fsQuad.render(e),this.separableBlurMaterials[o].uniforms.colorTexture.value=this.renderTargetsHorizontal[o].texture,this.separableBlurMaterials[o].uniforms.direction.value=m.BlurDirectionY,e.setRenderTarget(this.renderTargetsVertical[o]),e.clear(),this._fsQuad.render(e),u=this.renderTargetsVertical[o];this._fsQuad.material=this.compositeMaterial,this.compositeMaterial.uniforms.bloomStrength.value=this.strength,this.compositeMaterial.uniforms.bloomRadius.value=this.radius,this.compositeMaterial.uniforms.bloomTintColors.value=this.bloomTintColors,e.setRenderTarget(this.renderTargetsHorizontal[0]),e.clear(),this._fsQuad.render(e),this._fsQuad.material=this.blendMaterial,this.copyUniforms.tDiffuse.value=this.renderTargetsHorizontal[0].texture,r&&e.state.buffers.stencil.setTest(!0),this.renderToScreen?(e.setRenderTarget(null),this._fsQuad.render(e)):(e.setRenderTarget(t),this._fsQuad.render(e)),e.setClearColor(this._oldClearColor,this._oldClearAlpha),e.autoClear=a}_getSeparableBlurMaterial(e){const i=[],t=e/3;for(let a=0;a<e;a++)i.push(.39894*Math.exp(-.5*a*a/(t*t))/t);const s=[],r=[];for(let a=1;a<e;a+=2){const u=i[a],o=a+1<e?i[a+1]:0,g=u+o;s.push((a*u+(a+1)*o)/g),r.push(g)}return new d({defines:{KERNEL_PAIRS:s.length},uniforms:{colorTexture:{value:null},invSize:{value:new n(.5,.5)},direction:{value:new n(.5,.5)},centerWeight:{value:i[0]},gaussianOffsets:{value:s},gaussianWeights:{value:r}},vertexShader:`

				varying vec2 vUv;

				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}`,fragmentShader:`

				#include <common>

				varying vec2 vUv;

				uniform sampler2D colorTexture;
				uniform vec2 invSize;
				uniform vec2 direction;
				uniform float centerWeight;
				uniform float gaussianOffsets[KERNEL_PAIRS];
				uniform float gaussianWeights[KERNEL_PAIRS];

				void main() {

					vec3 diffuseSum = texture2D( colorTexture, vUv ).rgb * centerWeight;

					for ( int i = 0; i < KERNEL_PAIRS; i ++ ) {

						vec2 uvOffset = direction * invSize * gaussianOffsets[ i ];
						vec3 sample1 = texture2D( colorTexture, vUv + uvOffset ).rgb;
						vec3 sample2 = texture2D( colorTexture, vUv - uvOffset ).rgb;
						diffuseSum += ( sample1 + sample2 ) * gaussianWeights[ i ];

					}

					gl_FragColor = vec4( diffuseSum, 1.0 );

				}`})}_getCompositeMaterial(e){return new d({defines:{NUM_MIPS:e},uniforms:{blurTexture1:{value:null},blurTexture2:{value:null},blurTexture3:{value:null},blurTexture4:{value:null},blurTexture5:{value:null},bloomStrength:{value:1},bloomFactors:{value:null},bloomTintColors:{value:null},bloomRadius:{value:0}},vertexShader:`

				varying vec2 vUv;

				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}`,fragmentShader:`

				varying vec2 vUv;

				uniform sampler2D blurTexture1;
				uniform sampler2D blurTexture2;
				uniform sampler2D blurTexture3;
				uniform sampler2D blurTexture4;
				uniform sampler2D blurTexture5;
				uniform float bloomStrength;
				uniform float bloomRadius;
				uniform float bloomFactors[NUM_MIPS];
				uniform vec3 bloomTintColors[NUM_MIPS];

				float lerpBloomFactor( const in float factor ) {

					float mirrorFactor = 1.2 - factor;
					return mix( factor, mirrorFactor, bloomRadius );

				}

				void main() {

					// 3.0 for backwards compatibility with previous alpha-based intensity
					vec3 bloom = 3.0 * bloomStrength * (
						lerpBloomFactor( bloomFactors[ 0 ] ) * bloomTintColors[ 0 ] * texture2D( blurTexture1, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 1 ] ) * bloomTintColors[ 1 ] * texture2D( blurTexture2, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 2 ] ) * bloomTintColors[ 2 ] * texture2D( blurTexture3, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 3 ] ) * bloomTintColors[ 3 ] * texture2D( blurTexture4, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 4 ] ) * bloomTintColors[ 4 ] * texture2D( blurTexture5, vUv ).rgb
					);

					float bloomAlpha = max( bloom.r, max( bloom.g, bloom.b ) );
					gl_FragColor = vec4( bloom, bloomAlpha );

				}`})}}m.BlurDirectionX=new n(1,0);m.BlurDirectionY=new n(0,1);const Z=1.5;class J{constructor(e){f(this,"renderer");f(this,"target");f(this,"bloom");f(this,"output",new K);this.renderer=e;const i=e.getDrawingBufferSize(new n);this.target=new v(i.x,i.y,{type:T,samples:4}),this.bloom=new m(new n(i.x,i.y),.6,.4,Z),this.output.renderToScreen=!0}setSize(e,i,t){const s=Math.max(1,Math.floor(e*t)),r=Math.max(1,Math.floor(i*t));this.target.setSize(s,r),this.bloom.setSize(s,r)}render(e,i){const t=this.renderer;t.setRenderTarget(this.target),t.render(e,i),this.bloom.render(t,this.target,this.target,0,!1),this.output.render(t,this.target,this.target,0,!1),t.setRenderTarget(null)}dispose(){this.target.dispose(),this.bloom.dispose(),this.output.dispose()}}export{J as Post};
