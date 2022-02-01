import * as PIXI from 'pixi.js';
import RBush from 'rbush';

import { localizer } from '../core/localizer';
import { utilDisplayName, utilDisplayNameForPath } from '../util';


export function pixiLabels(context, featureCache) {
  let _labels = new Map();       // map of OSM ID -> label string
  let _texts = new Map();        // map of label -> Pixi Texture
  let _avoids = new Set();       // set of OSM ID we are avoiding

  // let _drawn = new RBush();
  // let _skipped = new RBush();
  let _placement = new RBush();
  let _lastk = 0;

  let _didInit = false;
  let _textStyle;


  function initLabels(context, layer) {
    _textStyle = new PIXI.TextStyle({
      fill: 0x333333,
      fontSize: 12,
      fontWeight: 600,
      miterLimit: 1,
      stroke: 0xeeeeee,
      strokeThickness: 3
    });

    const debugContainer = new PIXI.Container();
    debugContainer.name = 'label-debug';
    layer.addChild(debugContainer);

    _didInit = true;
  }



  function renderLabels(layer, projection, entities) {
    if (!_didInit) initLabels(context, layer);

    const SHOWBBOX = true;
    const debugContainer = layer.getChildByName('label-debug');

    const graph = context.graph();
    const k = projection.scale();
    let redoPlacement = false;   // we'll redo all the labels when scale changes


    if (k !== _lastk) {
console.log('LABEL RESET');
      _avoids.clear();
      _placement.clear();
      debugContainer.removeChildren();
      redoPlacement = true;
      _lastk = k;
    }


    function getLabel(entity) {
      if (!_labels.has(entity.id)) {
        const name = utilDisplayName(entity);
        _labels.set(entity.id, name);   // save display name in `_labels` cache
        return name;
      }
      return _labels.get(entity.id);
    }

    function hasPointLabel(entity) {
      const geom = entity.geometry(graph);
      return ((geom === 'vertex' || geom === 'point') && getLabel(entity));
    }
    function hasLineLabel(entity) {
      return (entity.geometry(graph) === 'line' && getLabel(entity));
    }
    function hasAreaLabel(entity) {
      return (entity.geometry(graph) === 'area' && getLabel(entity));
    }


    // Gather bounding boxes to avoid
    const stage = context.pixi.stage;
    let avoids = [];
    stage.getChildByName('vertices').children.forEach(gatherAvoids);
    stage.getChildByName('points').children.forEach(gatherAvoids);
    if (avoids.length) {
      _placement.load(avoids);  // bulk insert
    }

    function gatherAvoids(sourceObject) {
      if (!sourceObject.visible) return;

      const entityID = sourceObject.name;
      if (_avoids.has(entityID)) return;  // seen it already
      _avoids.add(entityID);

      const sourceFeature = featureCache.get(entityID);
      const rect = sourceFeature && sourceFeature.sceneBounds;
      if (!rect) return;

      // boxes here are in "scene" coordinates
      avoids.push({
        id: entityID,
        minX: rect.x,
        minY: rect.y,
        maxX: rect.x + rect.width,
        maxY: rect.y + rect.height
      });

      if (SHOWBBOX) {
        const bbox = new PIXI.Graphics()
          .lineStyle(2, 0xff3333)
          .drawShape(rect);
        debugContainer.addChild(bbox);
      }
    }

    const points = entities.filter(hasPointLabel)
      .sort((a, b) => b.loc[1] - a.loc[1]);

    // const lines = entities.filter(hasLineLabel).sort();
    // const areas = entities.filter(hasAreaLabel).sort();

    // Place point labels
    points
      .forEach(function preparePointLabels(entity) {
        let feature = featureCache.get(entity.id);
        if (!feature) return;

        // Add the label to an existing feature.
        if (!feature.label) {
          const container = new PIXI.Container();
          const label = _labels.get(entity.id);
          container.name = label;
          layer.addChild(container);

          let sprite;
          let existing = _texts.get(label);
          if (existing) {
            sprite = new PIXI.Sprite(existing.texture);
          } else {
            sprite = new PIXI.Text(label, _textStyle);
            _texts.set(label, sprite);
          }

          sprite.name = label;
          sprite.anchor.set(0.5, 0.5);   // middle, middle
          container.addChild(sprite);

          feature.label = {
            displayObject: container,
            localBounds: sprite.getLocalBounds(),
            origin: entity.loc,
            label: label,
            sprite: sprite
          };
        }

        // Remember scale and reproject only when it changes
        if (!redoPlacement && k === feature.label.k) return;
        feature.label.k = k;

// label _container_ should stay at 0,0?
        // const [x, y] = projection.project(feature.label.origin);
        // feature.label.displayObject.position.set(x, y);

        // Decide where to place the label
        // `f` - feature, these bounds are in "scene" coordinates
        const fRect = feature.sceneBounds.clone().pad(3, 1);
        const fLeft = fRect.x;
        const fTop = fRect.y;
        const fWidth = fRect.width;
        const fHeight = fRect.height;
        const fRight = fRect.x + fWidth;
        const fMidX = fRect.x + (fWidth * 0.5);
        const fBottom = fRect.y + fHeight;
        const fMidY = (feature.type === 'point') ? (fRect.y + fHeight - 15)  // next to marker
          : (fRect.y + (fHeight * 0.5));

        // `l` = label, these bounds are in "local" coordinates to the label,
        // 0,0 is the center of the label
        const lRect = feature.label.localBounds;
        const lLeft = lRect.x;
        const lTop = lRect.y;
        const lWidth = lRect.width;
        const lHalfWidth = lWidth * 0.5;
        const lHeight = lRect.height;
        const lHalfHeight = lHeight * 0.5;
        const lRight = lLeft + lWidth;
        const lBottom = lTop + lHeight;

        // Attempt several placements
        // (these are calculated in scene coordinates)
        const north = [fMidX, fTop - lHalfHeight];
        const east  = [fRight + lHalfWidth, fMidY];
        const south = [fMidX, fBottom + lHalfHeight];
        const west  = [fLeft - lHalfWidth,  fMidY];

        const placements = [east, south, west, north];


        // show debug boxes
        if (SHOWBBOX) {
          placements.forEach(([x,y]) => {
            const rect = new PIXI.Rectangle(x - lHalfWidth, y - lHalfHeight, lWidth, lHeight);
            const bbox = new PIXI.Graphics()
              .lineStyle(1, 0xffff33)
              .drawShape(rect);
            debugContainer.addChild(bbox);
          });
        }


        let didPlace = false;
        for (let i = 0; i < placements.length; i++) {
          const [x, y] = placements[i];
          const box = {
            id: entity.id,
            minX: x - lHalfWidth,
            minY: y - lHalfHeight,
            maxX: x + lHalfWidth,
            maxY: y + lHalfHeight
          };
          if (!_placement.collides(box)) {
            _placement.insert(box);
            feature.label.sprite.position.set(x, y);
const s = _labels.get(entity.id);
console.log(`placing ${s}`);
            didPlace = true;
            break;
          }
        }
        feature.label.sprite.visible = didPlace;
      });

//
//    // place line labels
//    lines
//      .forEach(function prepareLineLabels(entity) {
//        let feature = featureCache.get(entity.id);
//        if (!feature) return;
//
//        // Add the label to an existing feature.
//        if (!feature.label) {
//          const container = new PIXI.Container();
//          const label = _labels.get(entity.id);
//          container.name = label;
//          layer.addChild(container);
//
//          // for now
//          const target = entity.extent(graph).center();
//
//          let sprite;
//          let existing = _texts.get(label);
//          if (existing) {
//            sprite = new PIXI.Sprite(existing.texture);
//          } else {
//            sprite = new PIXI.Text(label, _textStyle);
//            _texts.set(label, sprite);
//          }
//
//          sprite.name = label;
//          sprite.anchor.set(0.5, 0.5);  // middle, middle
//          // sprite.angle = 40;
//          // sprite.position.set(0, 8);    // move below pin
//          container.addChild(sprite);
//
//          const rect = new PIXI.Rectangle();
//          sprite.getLocalBounds(rect);
//
//
//// experiments
//
//          const debug = new PIXI.Container();
//          debug.name = label + '-debug';
//          container.addChild(debug);
//
//          const bbox = new PIXI.Graphics()
//            .lineStyle(1, 0x00ffaa)
//            .drawShape(rect);
//          bbox.name = entity.id + '-bbox';
//          debug.addChild(bbox);
//
//
//          // try a rope?
//          let points = [];
//          let count = 10;
//          let span = rect.width / count;
//          for (let i = 0; i < count + 1; i++) {  // count+1 extra point at end
//            const x = span * i;
//            const y = Math.sin(i / Math.PI) * 10;
//            points.push(new PIXI.Point(x, y));
//          }
//          const rope = new PIXI.SimpleRope(sprite.texture, points);
//          rope.name = label + '-rope';
//          rope.position.set(-rect.width/2, 10);    // move below
//          container.addChild(rope);
//
////          // cover the text in small collision boxes
////          let rects = [];
////          const pad = 2;
////          const startx = -(rect.width / 2) - pad;
////          const endx = (rect.width / 2) + pad;
////          const starty = -(rect.height / 2) - pad;
////          const size = (rect.height + pad + pad);
////          const half = size / 2;
////          for (let x = startx, y = starty; x < (endx - half); x += half) {
////            const rect = new PIXI.Rectangle(x, y, size, size);
////            rects.push(rect);
////
////            const g = new PIXI.Graphics()
////              .lineStyle(1, 0xffff66)
////              .drawShape(rect);
////            g.name = entity.id + '-' + x.toString();
////            debug.addChild(g);
////          }
//
//
//          feature.label = {
//            displayObject: container,
//            debug: debug,
//            loc: target,
//            label: label,
//            sprite: sprite
//            // bbox: bbox
//          };
//        }
//
//        // remember scale and reproject only when it changes
//        if (k === feature.label.k) return;
//        feature.label.k = k;
//
//        const [x, y] = projection.project(feature.label.loc);
//        feature.label.displayObject.position.set(x, y);
//
//        // const offset = stage.position;
//        // feature.bbox.position.set(-offset.x, -offset.y);
//
//        // const rect = feature.displayObject.getBounds();
//        // feature.bbox
//        //   .clear()
//        //   .lineStyle(1, 0x66ff66)
//        //   .drawRect(rect.x, rect.y, rect.width, rect.height);
//      });
//

  }


//
//
//  function shouldSkipIcon(preset) {
//    const noIcons = ['building', 'landuse', 'natural'];
//    return noIcons.some(function(s) {
//      return preset.id.indexOf(s) >= 0;
//    });
//  }
//
//
//
//
//
//
//
//
//
//
//
//
//  function drawLineLabels(layer, graph, cache, entities, labels) {
//    drawPointLabels(layer, graph, cache, entities, labels, false);
//  }
//
//
//  function drawPointLabels(layer, graph, cache, entities, labels, drawIcons) {
//      let data = entities;
//
//      // gather ids to keep
//      let keep = {};
//      data.forEach(entity => keep[entity.id] = true);
//
//
//      // exit
//      [...cache.entries()].forEach(([id, data]) => {
//      if (!keep[id]) {
//          layer.removeChild(data.container);
//          cache.delete(id);
//      }
//      });
//
//      data.forEach((entity, i) => {
//          let feature = cache.get(entity.id);
//
//          if (!feature) {
//              const str = utilDisplayName(entity, true)
//              const text = new PIXI.Text(str, _textStyle);
//              text.name = str;
//              // text.width = labels[i].width || 100;
//              // text.height = labels[i].height || 18;
//              // text.x = 0;
//              // text.y = 0;
//              const container = new PIXI.Container();
//              container.name = str;
//
//              if (drawIcons) {
//                  const preset = presetManager.match(entity, graph);
//                  const picon = preset && preset.icon;
//
//                  if (picon) {
//                      let thisSprite = getIconSpriteHelper(context, picon);
//
//                      let iconsize = 16;
//                      thisSprite.x = text.width * 0.5 + -0.5 *iconsize;  //?
//                      thisSprite.y = -text.height -0.5 *iconsize;  //?
//                      thisSprite.width = iconsize;
//                      thisSprite.height = iconsize;
//                      container.addChild(thisSprite);
//                  }
//
//
//              container.addChild(text);
//              }
//              layer.addChild(container);
//
//              feature = {
//                  loc: [labels[i].x, labels[i].y],
//                  height: labels[i].height || 18,
//                  width: labels[i].width || 100,
//                  rotation: labels[i].rotation,
//                  container: container
//              };
//
//              cache.set(entity.id, feature);
//          }
//
//          feature.container.x = labels[i].x - Math.cos(feature.container.width) / 2;
//          feature.container.y = labels[i].y - Math.sin(feature.container.height) / 2;
//          feature.container.rotation = feature.rotation || 0;
//          // feature.container.height = feature.height;
//          // feature.container.width = feature.width;
//      });
//
//  }
//
//
//  function drawAreaLabels(layer, graph, entities, labels) {
//      let filteredEntities = entities.filter( (entity, i) => labels[i].hasOwnProperty('x') && labels[i].hasOwnProperty('y'));
//      let filteredLabels = labels.filter( label => label.hasOwnProperty('x') && label.hasOwnProperty('y'));
//      drawPointLabels(layer, graph, _areacache, filteredEntities, filteredLabels, true);
//  }


  // function drawAreaIcons(selection, entities, labels) {
  //     var icons = selection.selectAll('use.' + classes)
  //         .filter(filter)
  //         .data(entities, osmEntity.key);

  //     // exit
  //     icons.exit()
  //         .remove();

  //     // enter/update
  //     icons.enter()
  //         .append('use')
  //         .attr('class', 'icon ' + classes)
  //         .attr('width', '17px')
  //         .attr('height', '17px')
  //         .merge(icons)
  //         .attr('transform', get(labels, 'transform'))
  //         .attr('xlink:href', function(d) {
  //             var preset = presetManager.match(d, context.graph());
  //             var picon = preset && preset.icon;

  //             if (!picon) {
  //                 return '';
  //             } else {
  //                 var isMaki = /^maki-/.test(picon);
  //                 return '#' + picon + (isMaki ? '-15' : '');
  //             }
  //         });
  //
  //   function get(array, prop) {
  //     return function(d, i) { return array[i][prop]; };
  //   }

  // }

//       var labelable = [];
//       var renderNodeAs = {};
//       var i, j, k, entity, geometry;

//       for (i = 0; i < LABELSTACK.length; i++) {
//           labelable.push([]);
//       }

//       _rdrawn.clear();
//       _rskipped.clear();
//       _entitybboxes = {};


//       // Loop through all the entities to do some preprocessing
//       for (i = 0; i < entities.length; i++) {
//           entity = entities[i];
//           geometry = entity.geometry(graph);

//           // Insert collision boxes around interesting points/vertices
//           if (geometry === 'point' || (geometry === 'vertex' && isInterestingVertex(entity))) {
//               var hasDirections = entity.directions(graph, projection).length;
//               var markerPadding;

//               if (geometry === 'point') {
//                   renderNodeAs[entity.id] = 'point';
//                   markerPadding = 20;   // extra y for marker height
//               } else {
//                   renderNodeAs[entity.id] = 'vertex';
//                   markerPadding = 0;
//               }

//               var coord = projection(entity.loc);
//               var nodePadding = 10;
//               var bbox = {
//                   minX: coord[0] - nodePadding,
//                   minY: coord[1] - nodePadding - markerPadding,
//                   maxX: coord[0] + nodePadding,
//                   maxY: coord[1] + nodePadding
//               };

//               doInsert(bbox, entity.id + 'P');
//           }

//           // From here on, treat vertices like points
//           if (geometry === 'vertex') {
//               geometry = 'point';
//           }

//           // Determine which entities are label-able
//           var preset = geometry === 'area' && presetManager.match(entity, graph);
//           var icon = preset && !shouldSkipIcon(preset) && preset.icon;

//           if (!icon && !utilDisplayName(entity)) continue;

//           for (k = 0; k < LABELSTACK.length; k++) {
//               var matchGeom = LABELSTACK[k][0];
//               var matchKey = LABELSTACK[k][1];
//               var matchVal = LABELSTACK[k][2];
//               var hasVal = entity.tags[matchKey];

//               if (geometry === matchGeom && hasVal && (matchVal === '*' || matchVal === hasVal)) {
//                   labelable[k].push(entity);
//                   break;
//               }
//           }
//       }

//       var positions = {
//           point: [],
//           line: [],
//           area: []
//       };

//       var labelled = {
//           point: [],
//           line: [],
//           area: []
//       };

//       // Try and find a valid label for labellable entities
//       for (k = 0; k < labelable.length; k++) {
//           var fontSize = LABELSTACK[k][3];

//           for (i = 0; i < labelable[k].length; i++) {
//               entity = labelable[k][i];
//               geometry = entity.geometry(graph);

//               var getName = (geometry === 'line') ? utilDisplayNameForPath : utilDisplayName;
//               var name = getName(entity);
//               var width = 100;  // just guess  // name && textWidth(name, fontSize);
//               var p = null;

//               if (geometry === 'point' || geometry === 'vertex') {
//                   // no point or vertex labels in wireframe mode
//                   // no vertex labels at low zooms (vertices have no icons)
//                   if (wireframe) continue;
//                   var renderAs = renderNodeAs[entity.id];
//                   if (renderAs === 'vertex' && zoom < 17) continue;

//                   p = getPointLabel(entity, width, fontSize, renderAs);

//               } else if (geometry === 'line') {
//                   p = getLineLabel(entity, width, fontSize);

//               } else if (geometry === 'area') {
//                   p = getAreaLabel(entity, width, fontSize);
//               }

//               if (p) {
//                   if (geometry === 'vertex') { geometry = 'point'; }  // treat vertex like point
//                   p.classes = geometry + ' tag-' + LABELSTACK[k][1];
//                   positions[geometry].push(p);
//                   labelled[geometry].push(entity);
//               }
//           }
//       }


//       function isInterestingVertex(entity) {
//           var selectedIDs = context.selectedIDs();

//           return entity.hasInterestingTags() ||
//               entity.isEndpoint(graph) ||
//               entity.isConnected(graph) ||
//               selectedIDs.indexOf(entity.id) !== -1 ||
//               graph.parentWays(entity).some(function(parent) {
//                   return selectedIDs.indexOf(parent.id) !== -1;
//               });
//       }

//       function getPointLabel(entity, width, height, geometry) {
//           var y = (geometry === 'point' ? -12 : 0);
//           var pointOffsets = {
//               ltr: [15, y, 'start'],
//               rtl: [-15, y, 'end']
//           };

//           var textDirection = localizer.textDirection();

//           var coord = projection(entity.loc);
//           var textPadding = 2;
//           var offset = pointOffsets[textDirection];
//           var p = {
//               height: height,
//               width: width,
//               x: coord[0] + offset[0],
//               y: coord[1] + offset[1],
//               textAnchor: offset[2]
//           };

//           // insert a collision box for the text label..
//           var bbox;
//           if (textDirection === 'rtl') {
//               bbox = {
//                   minX: p.x - width - textPadding,
//                   minY: p.y - (height / 2) - textPadding,
//                   maxX: p.x + textPadding,
//                   maxY: p.y + (height / 2) + textPadding
//               };
//           } else {
//               bbox = {
//                   minX: p.x - textPadding,
//                   minY: p.y - (height / 2) - textPadding,
//                   maxX: p.x + width + textPadding,
//                   maxY: p.y + (height / 2) + textPadding
//               };
//           }

//           if (tryInsert([bbox], entity.id, true)) {
//               return p;
//           }
//       }


//       function getLineLabel(entity, width, height) {
//           var rect = context.projection.clipExtent();
//           var viewport = new Extent(rect[0], rect[1]).polygon();
//           var points = graph.childNodes(entity)
//               .map(function(node) { return projection(node.loc); });
//           var length = geomPathLength(points);

//           if (length < width + 20) return;

//           // % along the line to attempt to place the label
//           var lineOffsets = [50, 45, 55, 40, 60, 35, 65, 30, 70,
//                              25, 75, 20, 80, 15, 95, 10, 90, 5, 95];
//           var padding = 3;

//           for (var i = 0; i < lineOffsets.length; i++) {
//               var offset = lineOffsets[i];
//               var middle = offset / 100 * length;
//               var start = middle - width / 2;

//               if (start < 0 || start + width > length) continue;

//               // generate subpath and ignore paths that are invalid or don't cross viewport.
//               var sub = subpath(points, start, start + width);
//               if (!sub || !geomPolygonIntersectsPolygon(viewport, sub, true)) {
//                   continue;
//               }

//               var isReverse = reverse(sub);
//               if (isReverse) {
//                   sub = sub.reverse();
//               }

//               var bboxes = [];
//               var boxsize = (height + 2) / 2;

//               let longestCoordPair = [];
//               let longestLength = 0;
//               for (var j = 0; j < sub.length - 1; j++) {
//                   var a = sub[j];
//                   var b = sub[j + 1];

//                   let length = vecLength(a, b);
//                   if (longestLength < length) {
//                       longestLength = length;
//                       longestCoordPair = [a, b];
//                   }

//                   // split up the text into small collision boxes
//                   var num = Math.max(1, Math.floor(length / boxsize / 2));

//                   for (var box = 0; box < num; box++) {
//                       var p = vecInterp(a, b, box / num);
//                       var x0 = p[0] - boxsize - padding;
//                       var y0 = p[1] - boxsize - padding;
//                       var x1 = p[0] + boxsize + padding;
//                       var y1 = p[1] + boxsize + padding;

//                       bboxes.push({
//                           minX: Math.min(x0, x1),
//                           minY: Math.min(y0, y1),
//                           maxX: Math.max(x0, x1),
//                           maxY: Math.max(y0, y1)
//                       });
//                   }
//               }

//               // We've just calculated the longest way inside the sub geometry.
//               // Now, calculate that way's angle.
//               // This gives us our rotation for rendering.
//               var angle = Math.atan2(longestCoordPair[1][1] - longestCoordPair[0][1], longestCoordPair[1][0] - longestCoordPair[0][0]);


//               if (tryInsert(bboxes, entity.id, false)) {   // accept this one
//                   return {
//                       'font-size': height + 2,
//                       lineString: lineString(sub),
//                       x: sub[0][0],
//                       y: sub[0][1],
//                       length: longestLength,
//                       rotation: angle,
//                       startOffset: offset + '%'
//                   };
//               }
//           }

//           function reverse(p) {
//               var angle = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]);
//               return !(p[0][0] < p[p.length - 1][0] && angle < Math.PI/2 && angle > -Math.PI/2);
//           }

//           function lineString(points) {
//               return 'M' + points.join('L');
//           }

//           function subpath(points, from, to) {
//               var sofar = 0;
//               var start, end, i0, i1;

//               for (var i = 0; i < points.length - 1; i++) {
//                   var a = points[i];
//                   var b = points[i + 1];
//                   var current = vecLength(a, b);
//                   var portion;
//                   if (!start && sofar + current >= from) {
//                       portion = (from - sofar) / current;
//                       start = [
//                           a[0] + portion * (b[0] - a[0]),
//                           a[1] + portion * (b[1] - a[1])
//                       ];
//                       i0 = i + 1;
//                   }
//                   if (!end && sofar + current >= to) {
//                       portion = (to - sofar) / current;
//                       end = [
//                           a[0] + portion * (b[0] - a[0]),
//                           a[1] + portion * (b[1] - a[1])
//                       ];
//                       i1 = i + 1;
//                   }
//                   sofar += current;
//               }

//               var result = points.slice(i0, i1);
//               result.unshift(start);
//               result.push(end);
//               return result;
//           }
//       }



//       function getAreaLabel(entity, width, height) {
//           var centroid = path.centroid(entity.asGeoJSON(graph));
//           var extent = entity.extent(graph);
//           var areaWidth = projection(extent.max)[0] - projection(extent.min)[0];

//           if (isNaN(centroid[0]) || areaWidth < 20) return;

//           var preset = presetManager.match(entity, context.graph());
//           var picon = preset && preset.icon;
//           var iconSize = 17;
//           var padding = 2;
//           var p = {};

//           if (picon) {  // icon and label..
//               if (addIcon()) {
//                   addLabel(iconSize + padding);
//                   return p;
//               }
//           } else {   // label only..
//               if (addLabel(0)) {
//                   return p;
//               }
//           }


//           function addIcon() {
//               var iconX = centroid[0] - (iconSize / 2);
//               var iconY = centroid[1] - (iconSize / 2);
//               var bbox = {
//                   minX: iconX,
//                   minY: iconY,
//                   maxX: iconX + iconSize,
//                   maxY: iconY + iconSize
//               };

//               if (tryInsert([bbox], entity.id + 'I', true)) {
//                   p.transform = 'translate(' + iconX + ',' + iconY + ')';
//                   return true;
//               }
//               return false;
//           }

//           function addLabel(yOffset) {
//               if (width && areaWidth >= width + 20) {
//                   var labelX = centroid[0];
//                   var labelY = centroid[1] + yOffset;
//                   var bbox = {
//                       minX: labelX - (width / 2) - padding,
//                       minY: labelY - (height / 2) - padding,
//                       maxX: labelX + (width / 2) + padding,
//                       maxY: labelY + (height / 2) + padding
//                   };

//                   if (tryInsert([bbox], entity.id, true)) {
//                       p.x = labelX;
//                       p.y = labelY;
//                       p.textAnchor = 'middle';
//                       p.height = height;
//                       return true;
//                   }
//               }
//               return false;
//           }
//       }


//       // force insert a singular bounding box
//       // singular box only, no array, id better be unique
//       function doInsert(bbox, id) {
//           bbox.id = id;

//           var oldbox = _entitybboxes[id];
//           if (oldbox) {
//               _rdrawn.remove(oldbox);
//           }
//           _entitybboxes[id] = bbox;
//           _rdrawn.insert(bbox);
//       }


//       function tryInsert(bboxes, id, saveSkipped) {
//           var skipped = false;

//           for (var i = 0; i < bboxes.length; i++) {
//               var bbox = bboxes[i];
//               bbox.id = id;

//               // Check that label is visible
//               if (bbox.minX < 0 || bbox.minY < 0 || bbox.maxX > dimensions[0] || bbox.maxY > dimensions[1]) {
//                   skipped = true;
//                   break;
//               }
//               if (_rdrawn.collides(bbox)) {
//                   skipped = true;
//                   break;
//               }
//           }

//           _entitybboxes[id] = bboxes;

//           if (skipped) {
//               if (saveSkipped) {
//                   _rskipped.load(bboxes);
//               }
//           } else {
//               _rdrawn.load(bboxes);
//           }

//           return !skipped;
//       }

//       drawPointLabels(layer, graph, _pointcache, labelled.point, positions.point);
//       drawLineLabels(layer, graph, _linecache, labelled.line, positions.line);
//       drawAreaLabels(layer, graph, labelled.area,  positions.area);
//       // drawAreaLabels(halo, labelled.area, filter, 'arealabel-halo', positions.area);
// //         drawAreaIcons(layer, labelled.area,  positions.area);
//       // drawAreaIcons(halo, labelled.area, filter, 'areaicon-halo', positions.area);

//   }


  return renderLabels;
}


// Listed from highest to lowest priority
const LABELSTACK = [
  ['line', 'aeroway', '*', 12],
  ['line', 'highway', 'motorway', 12],
  ['line', 'highway', 'trunk', 12],
  ['line', 'highway', 'primary', 12],
  ['line', 'highway', 'secondary', 12],
  ['line', 'highway', 'tertiary', 12],
  ['line', 'highway', '*', 12],
  ['line', 'railway', '*', 12],
  ['line', 'waterway', '*', 12],
  ['area', 'aeroway', '*', 12],
  ['area', 'amenity', '*', 12],
  ['area', 'building', '*', 12],
  ['area', 'historic', '*', 12],
  ['area', 'leisure', '*', 12],
  ['area', 'man_made', '*', 12],
  ['area', 'natural', '*', 12],
  ['area', 'shop', '*', 12],
  ['area', 'tourism', '*', 12],
  ['area', 'camp_site', '*', 12],
  ['point', 'aeroway', '*', 10],
  ['point', 'amenity', '*', 10],
  ['point', 'building', '*', 10],
  ['point', 'historic', '*', 10],
  ['point', 'leisure', '*', 10],
  ['point', 'man_made', '*', 10],
  ['point', 'natural', '*', 10],
  ['point', 'shop', '*', 10],
  ['point', 'tourism', '*', 10],
  ['point', 'camp_site', '*', 10],
  ['line', 'name', '*', 12],
  ['area', 'name', '*', 12],
  ['point', 'name', '*', 10]
];
