import { select as d3_select } from '../d3.mjs';
import { HelveticerRegularJson, Font, WebGLRenderer, WebGLRenderTarget,
         CanvasTexture, TextureLoader,
         BufferGeometry, BufferAttribute, Float32BufferAttribute,
         Vector2, Vector3, Color, Points, PointsMaterial,
         LineSegments, LineDashedMaterial, LineBasicMaterial,
         OrbitControls, Raycaster, SVGRenderer } from '../three.mjs';
import { browser, settings, constants, internals, isBatchMode, isNodeJs, isFunc, isStr, getDocument } from '../core.mjs';
import { getElementRect, getAbsPosInCanvas } from './BasePainter.mjs';
import { TAttMarkerHandler } from './TAttMarkerHandler.mjs';
import { getSvgLineStyle } from './TAttLineHandler.mjs';


const HelveticerRegularFont = new Font(HelveticerRegularJson);

function createSVGRenderer(as_is, precision, doc) {
   if (as_is) {
      if (doc !== undefined)
         globalThis.docuemnt = doc;
      let rndr = new SVGRenderer();
      rndr.setPrecision(precision);
      return rndr;
   }

   const excl_style1 = ';stroke-opacity:1;stroke-width:1;stroke-linecap:round',
         excl_style2 = ';fill-opacity:1';

   let doc_wrapper = {
     svg_attr: {},
     svg_style: {},
     path_attr: {},
     accPath: '',
     createElementNS(ns,kind) {
        if (kind == 'path')
           return {
              _wrapper: this,
              setAttribute(name, value) {
                 // cut useless fill-opacity:1 at the end of many SVG attributes
                 if ((name == 'style') && value) {
                    let pos1 = value.indexOf(excl_style1);
                    if ((pos1 >= 0) && (pos1 == value.length - excl_style1.length))
                       value = value.slice(0, value.length - excl_style1.length);
                    let pos2 = value.indexOf(excl_style2);
                    if ((pos2 >= 0) && (pos2 == value.length - excl_style2.length))
                       value = value.slice(0, value.length - excl_style2.length);
                 }
                 this._wrapper.path_attr[name] = value;
              }
           }

        if (kind != 'svg') {
           console.error(`not supported element for SVGRenderer ${kind}`);
           return null;
        }

        return {
           _wrapper: this,
           childNodes: [], // may be accessed - make dummy
           style: this.svg_style, // for background color
           setAttribute(name, value) {
              this._wrapper.svg_attr[name] = value;
           },
           appendChild(node) {
              this._wrapper.accPath += `<path style="${this._wrapper.path_attr['style']}" d="${this._wrapper.path_attr['d']}"/>`;
              this._wrapper.path_attr = {};
           },
           removeChild(node) {
              this.childNodes = [];
           }
        };
     }
   };

   let originalDocument = globalThis.document;
   globalThis.document = doc_wrapper;

   let rndr = new SVGRenderer();

   globalThis.document = originalDocument;

   rndr.doc_wrapper = doc_wrapper; // use it to get final SVG code

   rndr.originalRender = rndr.render;

   rndr.render = function (scene, camera) {
      let originalDocument = globalThis.document;
      globalThis.document = this.doc_wrapper;

      this.originalRender(scene, camera);

      globalThis.document = originalDocument;
   }

   rndr.clearHTML = function() {
      this.doc_wrapper.accPath = '';
   }

   rndr.makeOuterHTML = function() {

      let wrap = this.doc_wrapper,
         _textSizeAttr = `viewBox="${wrap.svg_attr['viewBox']}" width="${wrap.svg_attr['width']}" height="${wrap.svg_attr['height']}"`,
         _textClearAttr = wrap.svg_style.backgroundColor ? ` style="background:${wrap.svg_style.backgroundColor}"` : '';

      return `<svg xmlns="http://www.w3.org/2000/svg" ${_textSizeAttr}${_textClearAttr}>${wrap.accPath}</svg>`;
   }

   rndr.setPrecision(precision);

   return rndr;
}


/** @ummary Define rendering kind which will be used for rendering of 3D elements
  * @param {value} [render3d] - preconfigured value, will be used if applicable
  * @return {value} - rendering kind, see constants.Render3D
  * @private */
function getRender3DKind(render3d) {
   if (!render3d) render3d = isBatchMode() ? settings.Render3DBatch : settings.Render3D;
   let rc = constants.Render3D;

   if (render3d == rc.Default) render3d = isBatchMode() ? rc.WebGLImage : rc.WebGL;
   if (isBatchMode() && (render3d == rc.WebGL)) render3d = rc.WebGLImage;

   return render3d;
}

let Handling3DDrawings = {

   /** @summary Access current 3d mode
     * @param {string} [new_value] - when specified, set new 3d mode
     * @return current value
     * @private */
   access3dKind(new_value) {
      let svg = this.getPadSvg();
      if (svg.empty()) return -1;

      // returns kind of currently created 3d canvas
      let kind = svg.property('can3d');
      if (new_value !== undefined) svg.property('can3d', new_value);
      return ((kind === null) || (kind === undefined)) ? -1 : kind;
   },

   /** @summary Returns size which availble for 3D drawing.
     * @desc One uses frame sizes for the 3D drawing - like TH2/TH3 objects
     * @private */
   getSizeFor3d(can3d, render3d) {

      if (can3d === undefined) {
         // analyze which render/embed mode can be used
         can3d = getRender3DKind();
         // all non-webgl elements can be embedded into SVG as is
         if (can3d !== constants.Render3D.WebGL)
            can3d = constants.Embed3D.EmbedSVG;
         else if (settings.Embed3D != constants.Embed3D.Default)
            can3d = settings.Embed3D;
         else if (browser.isFirefox)
            can3d = constants.Embed3D.Embed;
         else if (browser.chromeVersion > 95)
         // version 96 works partially, 97 works fine
            can3d = constants.Embed3D.Embed;
         else
            can3d = constants.Embed3D.Overlay;
      }

      let pad = this.getPadSvg(),
          clname = 'draw3d_' + (this.getPadName() || 'canvas');

      if (pad.empty()) {
         // this is a case when object drawn without canvas

         let rect = getElementRect(this.selectDom());

         if ((rect.height < 10) && (rect.width > 10)) {
            rect.height = Math.round(0.66 * rect.width);
            this.selectDom().style('height', rect.height + 'px');
         }
         rect.x = 0; rect.y = 0; rect.clname = clname; rect.can3d = -1;
         return rect;
      }

      let fp = this.getFramePainter(), pp = this.getPadPainter(), size;

      if (fp?.mode3d && (can3d > 0)) {
         size = fp.getFrameRect();
      } else {
         let elem = (can3d > 0) ? pad : this.getCanvSvg();
         size = { x: 0, y: 0, width: elem.property('draw_width'), height: elem.property('draw_height') };
         if (Number.isNaN(size.width) || Number.isNaN(size.height)) {
            size.width = pp.getPadWidth();
            size.height = pp.getPadHeight();
         } else if (fp && !fp.mode3d) {
            elem = this.getFrameSvg();
            size.x = elem.property('draw_x');
            size.y = elem.property('draw_y');
         }
      }

      size.clname = clname;
      size.can3d = can3d;

      let rect = pp?.getPadRect();
      if (rect) {
         // while 3D canvas uses area also for the axis labels, extend area relative to normal frame
         let dx = Math.round(size.width*0.07), dy = Math.round(size.height*0.05);

         size.x = Math.max(0, size.x-dx);
         size.y = Math.max(0, size.y-dy);
         size.width = Math.min(size.width + 2*dx, rect.width - size.x);
         size.height = Math.min(size.height + 2*dy, rect.height - size.y);
      }

      if (can3d === 1)
         size = getAbsPosInCanvas(this.getPadSvg(), size);

      return size;
   },

   /** @summary Clear all 3D drawings
     * @return can3d value - how webgl canvas was placed
     * @private */
   clear3dCanvas() {
      let can3d = this.access3dKind(null);
      if (can3d < 0) {
         // remove first child from main element - if it is canvas
         let main = this.selectDom().node(),
             chld = main ? main.firstChild : null;

         if (chld && !chld.$jsroot)
            chld = chld.nextSibling;

         if (chld && chld.$jsroot) {
            delete chld.painter;
            main.removeChild(chld);
         }
         return can3d;
      }

      let size = this.getSizeFor3d(can3d);

      if (size.can3d === 0) {
         d3_select(this.getCanvSvg().node().nextSibling).remove(); // remove html5 canvas
         this.getCanvSvg().style('display', null); // show SVG canvas
      } else {
         if (this.getPadSvg().empty()) return;

         this.apply3dSize(size).remove();

         this.getFrameSvg().style('display', null);  // clear display property
      }
      return can3d;
   },

   /** @summary Add 3D canvas
     * @private */
   add3dCanvas(size, canv, webgl) {

      if (!canv || (size.can3d < -1)) return;

      if (size.can3d === -1) {
         // case when 3D object drawn without canvas

         let main = this.selectDom().node();
         if (main !== null) {
            main.appendChild(canv);
            canv.painter = this;
            canv.$jsroot = true; // mark canvas as added by jsroot
         }

         return;
      }

      if ((size.can3d > 0) && !webgl)
         size.can3d = constants.Embed3D.EmbedSVG;

      this.access3dKind(size.can3d);

      if (size.can3d === 0) {
         this.getCanvSvg().style('display', 'none'); // hide SVG canvas

         this.getCanvSvg().node().parentNode.appendChild(canv); // add directly
      } else {
         if (this.getPadSvg().empty()) return;

         // first hide normal frame
         this.getFrameSvg().style('display', 'none');

         let elem = this.apply3dSize(size);

         elem.attr('title', '').node().appendChild(canv);
      }
   },

   /** @summary Apply size to 3D elements
     * @private */
   apply3dSize(size, onlyget) {

      if (size.can3d < 0) return d3_select(null);

      let elem;

      if (size.can3d > 1) {

         elem = this.getLayerSvg(size.clname);

         // elem = layer.select('.' + size.clname);
         if (onlyget) return elem;

         let svg = this.getPadSvg();

         if (size.can3d === constants.Embed3D.EmbedSVG) {
            // this is SVG mode or image mode - just create group to hold element

            if (elem.empty())
               elem = svg.insert('g', '.primitives_layer').attr('class', size.clname);

            elem.attr('transform', `translate(${size.x},${size.y})`);

         } else {

            if (elem.empty())
               elem = svg.insert('foreignObject', '.primitives_layer').attr('class', size.clname);

            elem.attr('x', size.x)
                .attr('y', size.y)
                .attr('width', size.width)
                .attr('height', size.height)
                .attr('viewBox', `0 0 ${size.width} ${size.height}`)
                .attr('preserveAspectRatio', 'xMidYMid');
         }

      } else {
         let prnt = this.getCanvSvg().node().parentNode;

         elem = d3_select(prnt).select('.' + size.clname);
         if (onlyget) return elem;

         // force redraw by resize
         this.getCanvSvg().property('redraw_by_resize', true);

         if (elem.empty())
            elem = d3_select(prnt).append('div').attr('class', size.clname)
                                  .style('user-select', 'none');

         // our position inside canvas, but to set 'absolute' position we should use
         // canvas element offset relative to first parent with non-static position
         // now try to use getBoundingClientRect - it should be more precise

         let pos0 = prnt.getBoundingClientRect();

         while (prnt) {
            if (prnt === document) { prnt = null; break; }
            try {
               if (getComputedStyle(prnt).position !== 'static') break;
            } catch (err) {
               break;
            }
            prnt = prnt.parentNode;
         }

         let pos1 = prnt?.getBoundingClientRect() ?? { top: 0, left: 0 },
             offx = Math.round(pos0.left - pos1.left),
             offy = Math.round(pos0.top - pos1.top);

         elem.style('position', 'absolute').style('left', (size.x + offx) + 'px').style('top', (size.y + offy) + 'px').style('width', size.width + 'px').style('height', size.height + 'px');
      }

      return elem;
   }

}; // Handling3DDrawings


/** @summary Assigns method to handle 3D drawings inside SVG
  * @private */
function assign3DHandler(painter) {
   Object.assign(painter, Handling3DDrawings);
}


/** @summary Creates renderer for the 3D drawings
  * @param {value} width - rendering width
  * @param {value} height - rendering height
  * @param {value} render3d - render type, see {@link constants.Render3D}
  * @param {object} args - different arguments for creating 3D renderer
  * @return {Promise} with renderer object
  * @private */

async function createRender3D(width, height, render3d, args) {

   let rc = constants.Render3D, promise, need_workaround = false, doc = getDocument();

   render3d = getRender3DKind(render3d);

   if (!args) args = { antialias: true, alpha: true };

   if (render3d == rc.WebGL) {
      // interactive WebGL Rendering
      promise = Promise.resolve(new WebGLRenderer(args));

   } else if (render3d == rc.SVG) {
      // SVG rendering
      let r = createSVGRenderer(false, 0, doc);

      if (isBatchMode()) {
         need_workaround = true;
      } else {
         r.jsroot_dom = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
         // d3_select(r.jsroot_dom).attr('width', width).attr('height', height);
      }
      promise = Promise.resolve(r);
   } else if (isNodeJs()) {
      // try to use WebGL inside node.js - need to create headless context
      promise = import('canvas').then(node_canvas => {
         args.canvas = node_canvas.default.createCanvas(width, height);
         args.canvas.addEventListener = function() { }; // dummy
         args.canvas.removeEventListener = function() { }; // dummy
         args.canvas.style = {};
         return import('gl');
      }).then(node_gl => {
         let gl = node_gl.default(width, height, { preserveDrawingBuffer: true });
         if (!gl) throw(Error('Fail to create headless-gl'));
         args.context = gl;
         gl.canvas = args.canvas;

         let r = new WebGLRenderer(args);

         r.jsroot_output = new WebGLRenderTarget(width, height);
         r.setRenderTarget(r.jsroot_output);
         need_workaround = true;
         return r;
      });

   } else {
      // rendering with WebGL directly into svg image
      let r = new WebGLRenderer(args);
      r.jsroot_dom = doc.createElementNS('http://www.w3.org/2000/svg', 'image');
      d3_select(r.jsroot_dom).attr('width', width).attr('height', height);
      promise = Promise.resolve(r);
   }

   return promise.then(renderer => {

      if (need_workaround) {
          if (!internals.svg_3ds) internals.svg_3ds = [];
         renderer.workaround_id = internals.svg_3ds.length;
         internals.svg_3ds[renderer.workaround_id] = '<svg></svg>'; // dummy, provided in afterRender3D

         // replace DOM element in renderer
         renderer.jsroot_dom = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
         renderer.jsroot_dom.setAttribute('jsroot_svg_workaround', renderer.workaround_id);
      } else if (!renderer.jsroot_dom) {
         renderer.jsroot_dom = renderer.domElement;
      }

      // res.renderer.setClearColor('#000000', 1);
      // res.renderer.setClearColor(0x0, 0);
      renderer.setSize(width, height);
      renderer.jsroot_render3d = render3d;

      // apply size to dom element
      renderer.setJSROOTSize = function(width, height) {
         if ((this.jsroot_render3d === constants.Render3D.WebGLImage) && !isBatchMode() && !isNodeJs())
            return d3_select(this.jsroot_dom).attr('width', width).attr('height', height);
      };

      return renderer;
   });
}


/** @summary Cleanup created renderer object
  * @private */
function cleanupRender3D(renderer) {
   if (!renderer) return;

   if (isNodeJs()) {
      let ctxt = isFunc(renderer.getContext) ? renderer.getContext() : null,
          ext = ctxt?.getExtension('STACKGL_destroy_context');
      if (ext) ext.destroy();
   } else {
      // suppress warnings in Chrome about lost webgl context, not required in firefox
      if (browser.isChrome && isFunc(renderer.forceContextLoss))
         renderer.forceContextLoss();

      if (isFunc(renderer.dispose))
         renderer.dispose();
   }
}

/** @summary Cleanup previous renderings before doing next one
  * @desc used together with SVG
  * @private */
function beforeRender3D(renderer) {
   if (renderer.clearHTML) renderer.clearHTML();
}

/** @summary Post-process result of rendering
  * @desc used together with SVG or node.js image rendering
  * @private */
function afterRender3D(renderer) {

   let rc = constants.Render3D;
   if (renderer.jsroot_render3d == rc.WebGL) return;

   if (renderer.jsroot_render3d == rc.SVG) {
      // case of SVGRenderer
      if (isBatchMode()) {
         internals.svg_3ds[renderer.workaround_id] = renderer.makeOuterHTML();
      } else {
         let parent = renderer.jsroot_dom.parentNode;
         if (parent) {
            parent.innerHTML = renderer.makeOuterHTML();
            renderer.jsroot_dom = parent.firstChild;
         }
      }
   } else if (isNodeJs()) {
      // this is WebGL rendering in node.js
      let canvas = renderer.domElement,
         context = canvas.getContext('2d');

      let pixels = new Uint8Array(4 * canvas.width * canvas.height);
      renderer.readRenderTargetPixels(renderer.jsroot_output, 0, 0, canvas.width, canvas.height, pixels);

      // small code to flip Y scale
      let indx1 = 0, indx2 = (canvas.height - 1) * 4 * canvas.width, k, d;
      while (indx1 < indx2) {
         for  (k = 0; k < 4 * canvas.width; ++k) {
            d = pixels[indx1 + k]; pixels[indx1 + k] = pixels[indx2 + k]; pixels[indx2 + k] = d;
         }
         indx1 += 4 * canvas.width;
         indx2 -= 4 * canvas.width;
      }

      let imageData = context.createImageData(canvas.width, canvas.height);
      imageData.data.set(pixels);
      context.putImageData(imageData, 0, 0);

      let dataUrl = canvas.toDataURL('image/png'),
          svg = `<image width="${canvas.width}" height="${canvas.height}" xlink:href="${dataUrl}"></image>`;
      internals.svg_3ds[renderer.workaround_id] = svg;
   } else {
      let dataUrl = renderer.domElement.toDataURL('image/png');
      d3_select(renderer.jsroot_dom).attr('xlink:href', dataUrl);
   }
}

/** @summary Special way to insert WebGL drawing into produced SVG batch code
  * @desc Used only in batch mode for SVG images generation
  * @private */
internals.processSvgWorkarounds = function(svg, keep_workarounds) {
   if (!internals.svg_3ds) return svg;
   for (let k = 0;  k < internals.svg_3ds.length; ++k)
      svg = svg.replace(`<path jsroot_svg_workaround="${k}"></path>`, internals.svg_3ds[k]);
   if (!keep_workarounds)
      internals.svg_3ds = undefined;
   return svg;
}

// ========================================================================================================

/**
 * @summary Tooltip handler for 3D drawings
 *
 * @private
 */

class TooltipFor3D {

   /** @summary constructor
     * @param {object} dom - DOM element
     * @param {object} canvas - canvas for 3D rendering */
   constructor(prnt, canvas) {
      this.tt = null;
      this.cont = null;
      this.lastlbl = '';
      this.parent = prnt ? prnt : document.body;
      this.canvas = canvas; // we need canvas to recalculate mouse events
      this.abspos = !prnt;
   }

   /** @summary check parent */
   checkParent(prnt) {
      if (prnt && (this.parent !== prnt)) {
         this.hide();
         this.parent = prnt;
      }
   }

   /** @summary extract position from event
     * @desc can be used to process it later when event is gone */
   extract_pos(e) {
      if (typeof e == 'object' && (e.u !== undefined) && (e.l !== undefined)) return e;
      let res = { u: 0, l: 0 };
      if (this.abspos) {
         res.l = e.pageX;
         res.u = e.pageY;
      } else {
         res.l = e.offsetX;
         res.u = e.offsetY;
      }

      return res;
   }

   /** @summary Method used to define position of next tooltip
     * @desc event is delivered from canvas,
     * but position should be calculated relative to the element where tooltip is placed */
   pos(e) {

      if (!this.tt) return;

      let pos = this.extract_pos(e);
      if (!this.abspos) {
         let rect1 = this.parent.getBoundingClientRect(),
             rect2 = this.canvas.getBoundingClientRect();

         if ((rect1.left !== undefined) && (rect2.left!== undefined)) pos.l += (rect2.left-rect1.left);

         if ((rect1.top !== undefined) && (rect2.top!== undefined)) pos.u += rect2.top-rect1.top;

         if (pos.l + this.tt.offsetWidth + 3 >= this.parent.offsetWidth)
            pos.l = this.parent.offsetWidth - this.tt.offsetWidth - 3;

         if (pos.u + this.tt.offsetHeight + 15 >= this.parent.offsetHeight)
            pos.u = this.parent.offsetHeight - this.tt.offsetHeight - 15;

         // one should find parent with non-static position,
         // all absolute coordinates calculated relative to such node
         let abs_parent = this.parent;
         while (abs_parent) {
            let style = getComputedStyle(abs_parent);
            if (!style || (style.position !== 'static')) break;
            if (!abs_parent.parentNode || (abs_parent.parentNode.nodeType != 1)) break;
            abs_parent = abs_parent.parentNode;
         }

         if (abs_parent && (abs_parent !== this.parent)) {
            let rect0 = abs_parent.getBoundingClientRect();
            pos.l += (rect1.left - rect0.left);
            pos.u += (rect1.top - rect0.top);
         }
      }

      this.tt.style.top = (pos.u + 15) + 'px';
      this.tt.style.left = (pos.l + 3) + 'px';
   }

   /** @summary Show tooltip */
   show(v /*, mouse_pos, status_func*/) {
      if (!v) return this.hide();

      if ((typeof v == 'object') && (v.lines || v.line)) {
         if (v.only_status) return this.hide();

         if (v.line) {
            v = v.line;
         } else {
            let res = v.lines[0];
            for (let n=1;n<v.lines.length;++n) res+= '<br/>' + v.lines[n];
            v = res;
         }
      }

      if (this.tt === null) {
         this.tt = document.createElement('div');
         this.tt.setAttribute('style', 'opacity: 1; filter: alpha(opacity=1); position: absolute; display: block; overflow: hidden; z-index: 101;');
         this.cont = document.createElement('div');
         this.cont.setAttribute('style', 'display: block; padding: 2px 12px 3px 7px; margin-left: 5px; font-size: 11px; background: #777; color: #fff;');
         this.tt.appendChild(this.cont);
         this.parent.appendChild(this.tt);
      }

      if (this.lastlbl !== v) {
         this.cont.innerHTML = v;
         this.lastlbl = v;
         this.tt.style.width = 'auto'; // let it be automatically resizing...
      }
   }

   /** @summary Hide tooltip */
   hide() {
      if (this.tt !== null)
         this.parent.removeChild(this.tt);

      this.tt = null;
      this.lastlbl = '';
   }

} // class TooltipFor3D

/** @summary Create OrbitControls for painter
  * @private */
function createOrbitControl(painter, camera, scene, renderer, lookat) {

   let control = null,
       enable_zoom = settings.Zooming && settings.ZoomMouse,
       enable_select = isFunc(painter.processMouseClick);

   function control_mousedown(evnt) {
      if (!control) return;

      // function used to hide some events from orbit control and redirect them to zooming rect
      if (control.mouse_zoom_mesh) {
         evnt.stopImmediatePropagation();
         evnt.stopPropagation();
         return;
      }

      // only left-button is considered
      if ((evnt.button!==undefined) && (evnt.button !== 0)) return;
      if ((evnt.buttons!==undefined) && (evnt.buttons !== 1)) return;

      if (control.enable_zoom) {
         control.mouse_zoom_mesh = control.detectZoomMesh(evnt);
         if (control.mouse_zoom_mesh) {
            // just block orbit control
            evnt.stopImmediatePropagation();
            evnt.stopPropagation();
            return;
         }
      }

      if (control.enable_select)
         control.mouse_select_pnt = control.getMousePos(evnt, {});
   }

   function control_mouseup(evnt) {
      if (!control) return;

      if (control.mouse_zoom_mesh && control.mouse_zoom_mesh.point2 && control.painter.get3dZoomCoord) {

         let kind = control.mouse_zoom_mesh.object.zoom,
             pos1 = control.painter.get3dZoomCoord(control.mouse_zoom_mesh.point, kind),
             pos2 = control.painter.get3dZoomCoord(control.mouse_zoom_mesh.point2, kind);

         if (pos1 > pos2) { let v = pos1; pos1 = pos2; pos2 = v; }

         if ((kind === 'z') && control.mouse_zoom_mesh.object.use_y_for_z) kind = 'y';

         // try to zoom
         if (pos1 < pos2)
           if (control.painter.zoom(kind, pos1, pos2))
              control.mouse_zoom_mesh = null;
      }

      // if selection was drawn, it should be removed and picture rendered again
      if (control.enable_zoom)
         control.removeZoomMesh();

      // only left-button is considered
      //if ((evnt.button!==undefined) && (evnt.button !== 0)) return;
      //if ((evnt.buttons!==undefined) && (evnt.buttons !== 1)) return;

      if (control.enable_select && control.mouse_select_pnt) {

         let pnt = control.getMousePos(evnt, {}),
             same_pnt = (pnt.x == control.mouse_select_pnt.x) && (pnt.y == control.mouse_select_pnt.y);
         delete control.mouse_select_pnt;

         if (same_pnt) {
            let intersects = control.getMouseIntersects(pnt);
            control.painter.processMouseClick(pnt, intersects, evnt);
         }
      }
   }

   function render3DFired(painter) {
      if (!painter || painter.renderer === undefined) return false;
      return painter.render_tmout !== undefined; // when timeout configured, object is prepared for rendering
   }

   function control_mousewheel(evnt) {
      if (!control) return;

      // try to handle zoom extra

      if (render3DFired(control.painter) || control.mouse_zoom_mesh) {
         evnt.preventDefault();
         evnt.stopPropagation();
         evnt.stopImmediatePropagation();
         return; // already fired redraw, do not react on the mouse wheel
      }

      let intersect = control.detectZoomMesh(evnt);
      if (!intersect) return;

      evnt.preventDefault();
      evnt.stopPropagation();
      evnt.stopImmediatePropagation();

      if (isFunc(control.painter?.analyzeMouseWheelEvent)) {
         let kind = intersect.object.zoom,
             position = intersect.point[kind],
             item = { name: kind, ignore: false };

         // z changes from 0..2*size_z3d, others -size_x3d..+size_x3d
         switch (kind) {
            case 'x': position = (position + control.painter.size_x3d)/2/control.painter.size_x3d; break;
            case 'y': position = (position + control.painter.size_y3d)/2/control.painter.size_y3d; break;
            case 'z': position = position/2/control.painter.size_z3d; break;
         }

         control.painter.analyzeMouseWheelEvent(evnt, item, position, false);

         if ((kind === 'z') && intersect.object.use_y_for_z) kind = 'y';

         control.painter.zoom(kind, item.min, item.max);
      }
   }

   // assign own handler before creating OrbitControl

   if (settings.Zooming && settings.ZoomWheel)
      renderer.domElement.addEventListener('wheel', control_mousewheel);

   if (enable_zoom || enable_select) {
      renderer.domElement.addEventListener('pointerdown', control_mousedown);
      renderer.domElement.addEventListener('pointerup', control_mouseup);
   }

   control = new OrbitControls(camera, renderer.domElement);

   control.enableDamping = false;
   control.dampingFactor = 1.0;
   control.enableZoom = true;
   control.enableKeys = settings.HandleKeys;

   if (lookat) {
      control.target.copy(lookat);
      control.target0.copy(lookat);
      control.update();
   }

   control.tooltip = new TooltipFor3D(painter.selectDom().node(), renderer.domElement);

   control.painter = painter;
   control.camera = camera;
   control.scene = scene;
   control.renderer = renderer;
   control.raycaster = new Raycaster();
   control.raycaster.params.Line.threshold = 10;
   control.raycaster.params.Points.threshold = 5;
   control.mouse_zoom_mesh = null; // zoom mesh, currently used in the zooming
   control.block_ctxt = false; // require to block context menu command appearing after control ends, required in chrome which inject contextmenu when key released
   control.block_mousemove = false; // when true, tooltip or cursor will not react on mouse move
   control.cursor_changed = false;
   control.control_changed = false;
   control.control_active = false;
   control.mouse_ctxt = { x:0, y: 0, on: false };
   control.enable_zoom = enable_zoom;
   control.enable_select = enable_select;

   control.cleanup = function() {
      if (settings.Zooming && settings.ZoomWheel)
         this.domElement.removeEventListener('wheel', control_mousewheel);
      if (this.enable_zoom || this.enable_select) {
         this.domElement.removeEventListener('pointerdown', control_mousedown);
         this.domElement.removeEventListener('pointerup', control_mouseup);
      }

      this.domElement.removeEventListener('click', this.lstn_click);
      this.domElement.removeEventListener('dblclick', this.lstn_dblclick);
      this.domElement.removeEventListener('contextmenu', this.lstn_contextmenu);
      this.domElement.removeEventListener('mousemove', this.lstn_mousemove);
      this.domElement.removeEventListener('mouseleave', this.lstn_mouseleave);

      this.dispose(); // this is from OrbitControl itself

      this.tooltip.hide();
      delete this.tooltip;
      delete this.painter;
      delete this.camera;
      delete this.scene;
      delete this.renderer;
      delete this.raycaster;
      delete this.mouse_zoom_mesh;
   }

   control.HideTooltip = function() {
      this.tooltip.hide();
   }

   control.getMousePos = function(evnt, mouse) {
      mouse.x = ('offsetX' in evnt) ? evnt.offsetX : evnt.layerX;
      mouse.y = ('offsetY' in evnt) ? evnt.offsetY : evnt.layerY;
      mouse.clientX = evnt.clientX;
      mouse.clientY = evnt.clientY;
      return mouse;
   }

   control.getOriginDirectionIntersects = function(origin, direction) {
      this.raycaster.set(origin, direction);
      let intersects = this.raycaster.intersectObjects(this.scene.children, true);
      // painter may want to filter intersects
      if (isFunc(this.painter.filterIntersects))
         intersects = this.painter.filterIntersects(intersects);
      return intersects;
   }

   control.getMouseIntersects = function(mouse) {
      // domElement gives correct coordinate with canvas render, but isn't always right for webgl renderer
      if (!this.renderer) return [];

      let sz = (this.renderer instanceof WebGLRenderer) ? this.renderer.getSize(new Vector2()) : this.renderer.domElement,
          pnt = { x: mouse.x / sz.width * 2 - 1, y: -mouse.y / sz.height * 2 + 1 };

      this.camera.updateMatrix();
      this.camera.updateMatrixWorld();
      this.raycaster.setFromCamera( pnt, this.camera );
      let intersects = this.raycaster.intersectObjects(this.scene.children, true);

      // painter may want to filter intersects
      if (isFunc(this.painter.filterIntersects))
         intersects = this.painter.filterIntersects(intersects);

      return intersects;
   }

   control.detectZoomMesh = function(evnt) {
      let mouse = this.getMousePos(evnt, {}),
          intersects = this.getMouseIntersects(mouse);
      if (intersects)
         for (let n = 0; n < intersects.length; ++n)
            if (intersects[n].object.zoom)
               return intersects[n];

      return null;
   }

   control.getInfoAtMousePosition = function(mouse_pos) {
      let intersects = this.getMouseIntersects(mouse_pos),
          tip = null, painter = null;

      for (let i = 0; i < intersects.length; ++i)
         if (intersects[i].object.tooltip) {
            tip = intersects[i].object.tooltip(intersects[i]);
            painter = intersects[i].object.painter;
            break;
      }

      if (tip && painter)
         return { obj: painter.getObject(),  name: painter.getObject().fName,
                  bin: tip.bin, cont: tip.value,
                  binx: tip.ix, biny: tip.iy, binz: tip.iz,
                  grx: (tip.x1+tip.x2)/2, gry: (tip.y1+tip.y2)/2, grz: (tip.z1+tip.z2)/2 };
   }

   control.processDblClick = function(evnt) {
      // first check if zoom mesh clicked
      let zoom_intersect = this.detectZoomMesh(evnt);
      if (zoom_intersect && this.painter) {
         this.painter.unzoom(zoom_intersect.object.use_y_for_z ? 'y' : zoom_intersect.object.zoom);
         return;
      }

      // then check if double-click handler assigned
      let fp = this.painter ? this.painter.getFramePainter() : null;
      if (isFunc(fp?._dblclick_handler)) {
         let info = this.getInfoAtMousePosition(this.getMousePos(evnt, {}));
         if (info) {
            fp._dblclick_handler(info);
            return;
         }
       }

       this.reset();
   }

   control.changeEvent = function() {
      this.mouse_ctxt.on = false; // disable context menu if any changes where done by orbit control
      this.painter.render3D(0);
      this.control_changed = true;
   }

   control.startEvent = function() {
      this.control_active = true;
      this.block_ctxt = false;
      this.mouse_ctxt.on = false;

      this.tooltip.hide();

      // do not reset here, problem of events sequence in orbitcontrol
      // it issue change/start/stop event when do zooming
      // control.control_changed = false;
   }

   control.endEvent = function() {
      this.control_active = false;
      if (this.mouse_ctxt.on) {
         this.mouse_ctxt.on = false;
         this.contextMenu(this.mouse_ctxt, this.getMouseIntersects(this.mouse_ctxt));
      } /* else if (this.control_changed) {
         // react on camera change when required
      } */
      this.control_changed = false;
   }

   control.mainProcessContextMenu = function(evnt) {
      evnt.preventDefault();
      this.getMousePos(evnt, this.mouse_ctxt);
      if (this.control_active)
         this.mouse_ctxt.on = true;
      else if (this.block_ctxt)
         this.block_ctxt = false;
      else
         this.contextMenu(this.mouse_ctxt, this.getMouseIntersects(this.mouse_ctxt));
   }

   control.contextMenu = function(/* pos, intersects */) {
      // do nothing, function called when context menu want to be activated
   }

   control.setTooltipEnabled = function(on) {
      this.block_mousemove = !on;
      if (on === false) {
         this.tooltip.hide();
         this.removeZoomMesh();
      }
   }

   control.removeZoomMesh = function() {
      if (this.mouse_zoom_mesh && this.mouse_zoom_mesh.object.showSelection())
         this.painter.render3D();
      this.mouse_zoom_mesh = null; // in any case clear mesh, enable orbit control again
   }

   control.mainProcessMouseMove = function(evnt) {
      if (!this.painter) return; // protect when cleanup

      if (this.control_active && evnt.buttons && (evnt.buttons & 2))
         this.block_ctxt = true; // if right button in control was active, block next context menu

      if (this.control_active || this.block_mousemove || !this.processMouseMove) return;

      if (this.mouse_zoom_mesh) {
         // when working with zoom mesh, need special handling

         let zoom2 = this.detectZoomMesh(evnt),
             pnt2 = (zoom2?.object === this.mouse_zoom_mesh.object) ? zoom2.point : this.mouse_zoom_mesh.object.globalIntersect(this.raycaster);

         if (pnt2) this.mouse_zoom_mesh.point2 = pnt2;

         if (pnt2 && this.painter.enable_highlight)
            if (this.mouse_zoom_mesh.object.showSelection(this.mouse_zoom_mesh.point, pnt2))
               this.painter.render3D(0);

         this.tooltip.hide();
         return;
      }

      evnt.preventDefault();

      // extract mouse position
      this.tmout_mouse = this.getMousePos(evnt, {});
      this.tmout_ttpos =  this.tooltip ? this.tooltip.extract_pos(evnt) : null;

      if (this.tmout_handle) {
         clearTimeout(this.tmout_handle);
         delete this.tmout_handle;
      }

      if (!this.mouse_tmout)
         this.delayedProcessMouseMove();
      else
         this.tmout_handle = setTimeout(() => this.delayedProcessMouseMove(), this.mouse_tmout);
   }

   control.delayedProcessMouseMove = function() {
      // remove handle - allow to trigger new timeout
      delete this.tmout_handle;
      if (!this.painter) return; // protect when cleanup

      let mouse = this.tmout_mouse,
          intersects = this.getMouseIntersects(mouse),
          tip = this.processMouseMove(intersects);

      if (tip) {
         let name = '', title = '', coord = '', info = '';
         if (mouse) coord = mouse.x.toFixed(0) + ',' + mouse.y.toFixed(0);
         if (isStr(tip)) {
            info = tip;
         } else {
            name = tip.name; title = tip.title;
            if (tip.line) info = tip.line; else
            if (tip.lines) { info = tip.lines.slice(1).join(' '); name = tip.lines[0]; }
         }
         this.painter.showObjectStatus(name, title, info, coord);
      }

      this.cursor_changed = false;
      if (tip && this.painter?.isTooltipAllowed()) {
         this.tooltip.checkParent(this.painter.selectDom().node());

         this.tooltip.show(tip, mouse);
         this.tooltip.pos(this.tmout_ttpos);
      } else {
         this.tooltip.hide();
         if (intersects)
            for (let n = 0; n < intersects.length; ++n)
               if (intersects[n].object.zoom) this.cursor_changed = true;
      }

      document.body.style.cursor = this.cursor_changed ? 'pointer' : 'auto';
   }

   control.mainProcessMouseLeave = function() {
      if (!this.painter) return; // protect when cleanup

      // do not enter main event at all
      if (this.tmout_handle) {
         clearTimeout(this.tmout_handle);
         delete this.tmout_handle;
      }
      this.tooltip.hide();
      if (isFunc(this.processMouseLeave))
         this.processMouseLeave();
      if (this.cursor_changed) {
         document.body.style.cursor = 'auto';
         this.cursor_changed = false;
      }
   }

   control.mainProcessDblClick = function(evnt) {
      // suppress simple click handler if double click detected
      if (this.single_click_tm) {
         clearTimeout(this.single_click_tm);
         delete this.single_click_tm;
      }
      this.processDblClick(evnt);
   }

   control.processClick = function(mouse_pos, kind) {
      delete this.single_click_tm;

      if (kind == 1) {
         let fp = this.painter ? this.painter.getFramePainter() : null;
         if (isFunc(fp?._click_handler)) {
            let info = this.getInfoAtMousePosition(mouse_pos);
            if (info) {
               fp._click_handler(info);
               return;
            }
         }
      }

      // method assigned in the Eve7 and used for object selection
      if ((kind == 2) && isFunc(this.processSingleClick)) {
         let intersects = this.getMouseIntersects(mouse_pos);
         this.processSingleClick(intersects);
      }
   };

   control.lstn_click = function(evnt) {
      // ignore right-mouse click
      if (evnt.detail == 2) return;

      if (this.single_click_tm) {
         clearTimeout(this.single_click_tm);
         delete this.single_click_tm;
      }

      let kind = 0, fp = this.painter?.getFramePainter();
      if (isFunc(fp?._click_handler))
         kind = 1; // user click handler
      else if (this.processSingleClick && this.painter?.options?.mouse_click)
         kind = 2;  // eve7 click handler

      // if normal event, set longer timeout waiting if double click not detected
      if (kind)
         this.single_click_tm = setTimeout(this.processClick.bind(this, this.getMousePos(evnt, {}), kind), 300);
   }.bind(control);

   control.addEventListener('change', () => control.changeEvent());
   control.addEventListener('start', () => control.startEvent());
   control.addEventListener('end', () => control.endEvent());

   control.lstn_contextmenu = evnt => control.mainProcessContextMenu(evnt);
   control.lstn_dblclick = evnt => control.mainProcessDblClick(evnt);
   control.lstn_mousemove = evnt => control.mainProcessMouseMove(evnt);
   control.lstn_mouseleave = () => control.mainProcessMouseLeave();

   renderer.domElement.addEventListener('click', control.lstn_click);
   renderer.domElement.addEventListener('dblclick', control.lstn_dblclick);
   renderer.domElement.addEventListener('contextmenu', control.lstn_contextmenu);
   renderer.domElement.addEventListener('mousemove', control.lstn_mousemove);
   renderer.domElement.addEventListener('mouseleave', control.lstn_mouseleave);

   return control;
}

/** @summary Method cleanup three.js object as much as possible.
  * @desc Simplify JS engine to remove it from memory
  * @private */
function disposeThreejsObject(obj, only_childs) {
   if (!obj) return;

   if (obj.children) {
      for (let i = 0; i < obj.children.length; i++)
         disposeThreejsObject(obj.children[i]);
   }

   if (only_childs) {
      obj.children = [];
      return;
   }

   obj.children = undefined;

   if (obj.geometry) {
      obj.geometry.dispose();
      obj.geometry = undefined;
   }
   if (obj.material) {
      if (obj.material.map) {
         obj.material.map.dispose();
         obj.material.map = undefined;
      }
      obj.material.dispose();
      obj.material = undefined;
   }

   // cleanup jsroot fields to simplify browser cleanup job
   delete obj.painter;
   delete obj.bins_index;
   delete obj.tooltip;
   delete obj.stack; // used in geom painter
   delete obj.drawn_highlight; // special highlight object

   obj = undefined;
}


/** @summary Create LineSegments mesh (or only geometry)
  * @desc If required, calculates lineDistance attribute for dashed geometries
  * @private */
function createLineSegments(arr, material, index = undefined, only_geometry = false) {

   let geom = new BufferGeometry();

   geom.setAttribute('position', arr instanceof Float32Array ? new BufferAttribute(arr, 3) : new Float32BufferAttribute(arr, 3));
   if (index) geom.setIndex(new BufferAttribute(index, 1));

   if (material.isLineDashedMaterial) {

      let v1 = new Vector3(),
          v2 = new Vector3(),
          d = 0, distances = null;

      if (index) {
         distances = new Float32Array(index.length);
         for (let n = 0; n < index.length; n += 2) {
            let i1 = index[n], i2 = index[n+1];
            v1.set(arr[i1],arr[i1+1],arr[i1+2]);
            v2.set(arr[i2],arr[i2+1],arr[i2+2]);
            distances[n] = d;
            d += v2.distanceTo(v1);
            distances[n+1] = d;
         }
      } else {
         distances = new Float32Array(arr.length/3);
         for (let n = 0; n < arr.length; n += 6) {
            v1.set(arr[n],arr[n+1],arr[n+2]);
            v2.set(arr[n+3],arr[n+4],arr[n+5]);
            distances[n/3] = d;
            d += v2.distanceTo(v1);
            distances[n/3+1] = d;
         }
      }
      geom.setAttribute('lineDistance', new BufferAttribute(distances, 1));
   }

   return only_geometry ? geom : new LineSegments(geom, material);
}

/** @summary Help structures for calculating Box mesh
  * @private */
const Box3D = {
    Vertices: [ new Vector3(1, 1, 1), new Vector3(1, 1, 0),
                new Vector3(1, 0, 1), new Vector3(1, 0, 0),
                new Vector3(0, 1, 0), new Vector3(0, 1, 1),
                new Vector3(0, 0, 0), new Vector3(0, 0, 1) ],
    Indexes: [ 0,2,1, 2,3,1, 4,6,5, 6,7,5, 4,5,1, 5,0,1, 7,6,2, 6,3,2, 5,7,0, 7,2,0, 1,3,4, 3,6,4 ],
    Normals: [ 1,0,0, -1,0,0, 0,1,0, 0,-1,0, 0,0,1, 0,0,-1 ],
    Segments: [0, 2, 2, 7, 7, 5, 5, 0, 1, 3, 3, 6, 6, 4, 4, 1, 1, 0, 3, 2, 6, 7, 4, 5]  // segments addresses Vertices
};

// these segments address vertices from the mesh, we can use positions from box mesh
Box3D.MeshSegments = (function() {
   let box3d = Box3D,
       arr = new Int32Array(box3d.Segments.length);

   for (let n = 0; n < arr.length; ++n) {
      for (let k = 0; k < box3d.Indexes.length; ++k)
         if (box3d.Segments[n] === box3d.Indexes[k]) {
            arr[n] = k; break;
         }
   }
   return arr;
})();


/**
 * @summary Abstract interactive control interface for 3D objects
 *
 * @abstract
 * @private
 */

class InteractiveControl {
   cleanup() {}
   extractIndex(/*intersect*/) {}
   setSelected(/*col, indx*/) {}
   setHighlight(/*col, indx*/) {}
   checkHighlightIndex(/*indx*/) {}
} // class InteractiveControl


/**
 * @summary Special class to control highliht and selection of single points, used in geo painter
 *
 * @private
 */

class PointsControl extends InteractiveControl {

   /** @summary constructor
     * @param {object} mesh - draw object */
   constructor(mesh) {
      super();
      this.mesh = mesh;
   }

   /** @summary cleanup object */
   cleanup() {
      if (!this.mesh) return;
      delete this.mesh.is_selected;
      this.createSpecial(null);
      delete this.mesh;
   }

   /** @summary extract intersect index */
   extractIndex(intersect) {
      return intersect && intersect.index!==undefined ? intersect.index : undefined;
   }

   /** @summary set selection */
   setSelected(col, indx) {
      let m = this.mesh;
      if ((m.select_col == col) && (m.select_indx == indx)) {
         col = null; indx = undefined;
      }
      m.select_col = col;
      m.select_indx = indx;
      this.createSpecial(col, indx);
      return true;
   }

   /** @summary set highlight */
   setHighlight(col, indx) {
      let m = this.mesh;
      m.h_index = indx;
      if (col)
         this.createSpecial(col, indx);
      else
         this.createSpecial(m.select_col, m.select_indx);
      return true;
   }

   /** @summary create special object */
   createSpecial(color, index) {
      let m = this.mesh;
      if (!color) {
         if (m.js_special) {
            m.remove(m.js_special);
            disposeThreejsObject(m.js_special);
            delete m.js_special;
         }
         return;
      }

      if (!m.js_special) {
         let geom = new BufferGeometry();
         geom.setAttribute( 'position', m.geometry.getAttribute('position'));
         let material = new PointsMaterial({ size: m.material.size*2, color });
         material.sizeAttenuation = m.material.sizeAttenuation;

         m.js_special = new Points(geom, material);
         m.js_special.jsroot_special = true; // special object, exclude from intersections
         m.add(m.js_special);
      }

      m.js_special.material.color = new Color(color);
      if (index !== undefined) m.js_special.geometry.setDrawRange(index, 1);
   }

} // class PointsControl


/**
 * @summary Class for creation of 3D points
 *
 * @private
 */

class PointsCreator {

   /** @summary constructor
     * @param {number} size - number of points
     * @param {boolean} [iswebgl=true] - if WebGL is used
     * @param {number} [scale=1] - scale factor */
   constructor(size, iswebgl, scale) {
      this.webgl = (iswebgl === undefined) ? true : iswebgl;
      this.scale = scale || 1.;

      this.pos = new Float32Array(size*3);
      this.geom = new BufferGeometry();
      this.geom.setAttribute('position', new BufferAttribute(this.pos, 3));
      this.indx = 0;
   }

   /** @summary Add point */
   addPoint(x,y,z) {
      this.pos[this.indx]   = x;
      this.pos[this.indx+1] = y;
      this.pos[this.indx+2] = z;
      this.indx += 3;
   }

   /** @summary Create points */
   createPoints(args) {

      if (typeof args !== 'object')
         args = { color: args };
      if (!args.color)
         args.color = 'black';

      let k = 1;

      // special dots
      if (!args.style) k = 1.1; else
      if (args.style === 1) k = 0.3; else
      if (args.style === 6) k = 0.5; else
      if (args.style === 7) k = 0.7;

      let makePoints = texture => {
         let material_args = { size: 3*this.scale*k };
         if (texture) {
            material_args.map = texture;
            material_args.transparent = true;
         } else {
            material_args.color = args.color || 'black';
         }

         let pnts = new Points(this.geom, new PointsMaterial(material_args));
         pnts.nvertex = 1;
         return pnts;
      };

      // this is plain creation of points, no need for texture loading

      if (k !== 1) {
         let res = makePoints();
         return this.noPromise ? res : Promise.resolve(res);
      }

      let handler = new TAttMarkerHandler({ style: args.style, color: args.color, size: 7 }),
          w = handler.fill ? 1 : 7,
          imgdata = `<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg">` +
                    `<path d="${handler.create(32,32)}" style="stroke: ${handler.getStrokeColor()}; stroke-width: ${w}; fill: ${handler.getFillColor()}"></path>`+
                    `</svg>`,
          dataUrl = 'data:image/svg+xml;charset=utf8,' + (isNodeJs() ? imgdata : encodeURIComponent(imgdata)),
          promise;

      if (isNodeJs()) {
         promise = import('canvas').then(handle => handle.default.loadImage(dataUrl).then(img => {
               const canvas = handle.default.createCanvas(64, 64),
                     ctx = canvas.getContext('2d');
               ctx.drawImage(img, 0, 0, 64, 64);
               return new CanvasTexture(canvas);
            }));
      } else if (this.noPromise) {
         // only for v6 support
         return makePoints(new TextureLoader().load(dataUrl));
      } else {
         promise = new Promise((resolveFunc, rejectFunc) => {
            let loader = new TextureLoader();
            loader.load(dataUrl, res => resolveFunc(res), undefined, () => rejectFunc());
         });
      }

      return promise.then(makePoints);
   }

} // class PointsCreator


/** @summary Create material for 3D line
  * @desc Takes into account dashed properties
  * @private */
function create3DLineMaterial(painter, arg, is_v7 = false) {
   if (!painter || !arg) return null;

   let lcolor, lstyle, lwidth;
   if (isStr(arg) || is_v7) {
      lcolor = painter.v7EvalColor(arg+'color', 'black');
      lstyle = parseInt(painter.v7EvalAttr(arg+'style', 0));
      lwidth = parseInt(painter.v7EvalAttr(arg+'width', 1));
   } else {
      lcolor = painter.getColor(arg.fLineColor);
      lstyle = arg.fLineStyle;
      lwidth = arg.fLineWidth;
   }

   let style = lstyle ? getSvgLineStyle(lstyle) : '',
       dash = style ? style.split(',') : [], material;

   if (dash && dash.length >= 2)
      material = new LineDashedMaterial({ color: lcolor, dashSize: parseInt(dash[0]), gapSize: parseInt(dash[1]) });
   else
      material = new LineBasicMaterial({ color: lcolor });

   if (lwidth && (lwidth > 1)) material.linewidth = lwidth;

   return material;
}

export { assign3DHandler, disposeThreejsObject, createOrbitControl,
         createLineSegments, create3DLineMaterial, Box3D,
         createRender3D, beforeRender3D, afterRender3D, getRender3DKind, cleanupRender3D,
         HelveticerRegularFont, InteractiveControl, PointsControl, PointsCreator, createSVGRenderer };
