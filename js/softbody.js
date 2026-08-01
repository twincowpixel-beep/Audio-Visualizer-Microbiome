// ===== THE SOFTBODY MEMBRANE ENGINE ==================================
// Extracted verbatim from Radio-Jungle v6.6 so the physics playground and the
// game can run the SAME code instead of two copies that quietly drift apart.
//
// PINNED, NOT SHARED. The playground loads js/softbody.lab.js — its own copy of
// this file — so physics can be tweaked and beta-tested there without touching
// the live game. `python3 promote-physics.py` diffs the two and promotes the lab
// copy to this one when a change is ready. Do not point the playground at this
// file; that is the whole point of the arrangement.
//
// The extraction was behaviour-neutral: the block had exactly ONE external
// dependency (outlineSkin), now SoftBody.params.outlineSkin. Verified by a
// deterministic fingerprint (fixed geometry, fixed impulses, 240 steps, hashed
// displacement array) taken before and after — see HANDOFF section 6BU.
(function (global) {
    'use strict';
    const THREE = global.THREE;
    // ===== THE TUNABLES (P3) =========================================
    // Everything below used to be a bare number inside softUpdate. They are
    // MULTIPLIERS on the existing rigidity-coupled formulas rather than raw
    // coefficients, for two reasons: the coupling to rigidity is what makes a
    // soft body behave differently from a firm one and should not be thrown away
    // to expose a slider, and a multiplier that defaults to 1.0 makes the
    // extraction provably behaviour-neutral — the fingerprint (section 6BU)
    // cannot move if every knob is x1.
    //
    // The clamps on damping and smoothing exist because those two feed back into
    // themselves: above 1.0 the membrane gains energy every step and the body
    // detonates. They do not bind at the defaults.
    const SOFT = {
        outlineSkin: 0.46,
        pressure: 1,    // volume restoration — how hard it wants to be round again
        tension:  1,    // surface tension — how tightly the skin pulls flat
        wave:     1,    // ripple propagation speed across the membrane
        memory:   1,    // shape memory — pull back toward the rest pose
        damping:  1,    // how quickly a wobble dies (higher = wobbles longer)
        indent:   1,    // how deep a dent may go
        outdent:  1,    // how far a bulge may push out
        collide:  1,    // stiffness of body-vs-body squish
        smooth:   1     // neighbour smoothing — high is gooey, low is beady
    };

        function buildSoftSkeleton(geo) {
            const pos = geo.attributes.position, count = pos.count;
            const base = new Float32Array(count * 3);
            const rnorm = new Float32Array(count * 3);
            const rigid = new Float32Array(count);
            let maxR = 0, minR = Infinity, minY = Infinity;
            for (let i = 0; i < count; i++) {
                const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
                base[i * 3] = x; base[i * 3 + 1] = y; base[i * 3 + 2] = z;
                let len = Math.hypot(x, y, z);
                if (len > maxR) maxR = len;
                if (len < minR) minR = len;
                if (y < minY) minY = y;          // lowest vertex → true resting height
                if (len === 0) len = 0.0001;
                rnorm[i * 3] = x / len; rnorm[i * 3 + 1] = y / len; rnorm[i * 3 + 2] = z / len;
            }
            // Per-vertex radius + rigidity. Rigidity rises with radius (rim
            // deforms, core resists) BUT keeps a floor: an exposed low-radius tip
            // — a cone/pyramid APEX sits near the central axis so it reads as
            // "low radius" — must NOT be treated as a free-floating soft core, or
            // it caves in and inverts (the raindrop bug). The floor keeps tips firm.
            const baseR = new Float32Array(count);
            for (let i = 0; i < count; i++) {
                const len = Math.hypot(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
                baseR[i] = len;
                const ratio = (maxR - minR < 0.01) ? 1.0 : (len - minR) / (maxR - minR);
                rigid[i] = 0.28 + 0.72 * ratio;
            }
            // Neighbour links: weld coincident duplicates (box/cone seams move as
            // one → no tearing) + the 6 nearest distinct vertices.
            const neighbors = Array.from({ length: count }, () => []);
            for (let i = 0; i < count; i++) {
                const x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2];
                const closest = [];
                for (let j = 0; j < count; j++) {
                    if (i === j) continue;
                    const dx = x - base[j * 3], dy = y - base[j * 3 + 1], dz = z - base[j * 3 + 2];
                    const dSq = dx * dx + dy * dy + dz * dz;
                    if (dSq <= 0.0001) { neighbors[i].push(j); }
                    else if (closest.length < 6 || dSq < closest[5].dSq) {
                        closest.push({ index: j, dSq });
                        closest.sort((a, b) => a.dSq - b.dSq);
                        if (closest.length > 6) closest.pop();
                    }
                }
                for (const c of closest) neighbors[i].push(c.index);
            }
            let restVol = 0;
            for (let i = 0; i < count; i++) {
                const l = Math.hypot(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
                restVol += l * l * l;
            }
            return { count, base, baseR, rnorm, rigid, neighbors, maxR, restVol, bottomExtent: -minY };
        }

        // A creature's per-instance softbody: shares `skel`, owns disp/vel + the
        // cloned geometry it deforms. `rigidity` (0 soft → 1 firm) sets squishiness.
        function makeSoftBody(mesh, skel, rigidity) {
            return {
                mesh, skel, rigidity: rigidity === undefined ? 0.5 : rigidity,
                disp: new Float32Array(skel.count),
                vel: new Float32Array(skel.count),
                nextVel: new Float32Array(skel.count),
                smoothed: new Float32Array(skel.count)
            };
        }

        const _sbIM = new THREE.Matrix4(), _sbLP = new THREE.Vector3(), _sbWS = new THREE.Vector3();
        // One physics step of a creature's membrane. `colliders` = [{pos(world),
        // radius}] of nearby creatures; `groundY` = world height below which
        // vertices are pressed back up (the floor contact patch).
        function softUpdate(sb, colliders, groundY) {
            const mesh = sb.mesh, skel = sb.skel, count = skel.count;
            const posAttr = mesh.geometry.attributes.position;
            mesh.updateWorldMatrix(true, false);   // bake in the group's transform this frame
            _sbIM.copy(mesh.matrixWorld).invert();
            const localScale = mesh.getWorldScale(_sbWS).x || 1;
            const m = mesh.matrixWorld.elements;   // row-1 (world Y) = m[1],m[5],m[9],m[13]
            // The local vector that maps to world UP. For an unrotated body this is
            // just local +Y, but a rolling roller tumbles, and the floor clamp below
            // has to lift along the true up or the contact patch spins off the floor.
            const upGx = m[1], upGy = m[5], upGz = m[9];
            const upG2 = (upGx * upGx + upGy * upGy + upGz * upGz) || 1;

            // Internal volume-pressure score → gentle restoring push toward round.
            let curVol = 0;
            for (let i = 0; i < count; i++) {
                const baseR = Math.hypot(skel.base[i * 3], skel.base[i * 3 + 1], skel.base[i * 3 + 2]);
                const cr = baseR + sb.disp[i];
                curVol += cr * cr * cr;
            }
            const globalPressure = ((skel.restVol - curVol) / count) * 0.015 * 2.5 * SOFT.pressure;

            const rg = sb.rigidity;
            // Reference tuning (SoftBodyPhysicsPlayground-0.2): stiffer membrane +
            // a shape-memory term, so the jello is noticeably calmer than before.
            const baseTension = (0.008 + rg * 0.11) * SOFT.tension;
            const waveSpeed = (0.2 + rg * 0.5) * SOFT.wave;
            // These used to be CONSTANT, which is why the rigidity slider barely did
            // anything: a soft membrane was still yanked back by full-strength shape
            // memory and clamped by fixed limits. Everything that resists deformation
            // now scales with rigidity, so soft really is soft.
            const shapeMemory = (0.008 + rg * 0.085) * SOFT.memory;
            const damping = Math.min(0.995, (0.60 + rg * 0.15) * SOFT.damping);   // soft -> wobbles longer
            const soft = 1.0 - rg;                     // 0 firm … 1 very squishy
            // Soft membranes are allowed to deform much further than firm ones.
            const maxIndent = skel.maxR * (0.42 + soft * 0.52) * SOFT.indent;
            const maxOutdent = skel.maxR * (0.22 + soft * 0.46) * SOFT.outdent;
            const breakThresh = (1.1 - rg) * 0.25 * skel.maxR;

            // Nearby creature colliders in this body's local space.
            const lcs = [];
            for (const c of colliders) {
                if (c.pos === mesh.position) continue;
                _sbLP.copy(c.pos).applyMatrix4(_sbIM);
                const lr = c.radius / localScale;
                const distC = _sbLP.length();
                const absorb = skel.maxR * (0.9 - rg * 0.8);
                const burst = Math.max(0, Math.min(1, (distC - absorb) / (skel.maxR * 0.25)));
                lcs.push({ x: _sbLP.x, y: _sbLP.y, z: _sbLP.z, r: lr, burst });
            }

            for (let i = 0; i < count; i++) {
                const nx = skel.rnorm[i * 3], ny = skel.rnorm[i * 3 + 1], nz = skel.rnorm[i * 3 + 2];
                const bx = skel.base[i * 3], by = skel.base[i * 3 + 1], bz = skel.base[i * 3 + 2];
                const d = sb.disp[i], vRig = skel.rigid[i];
                const localTension = baseTension * (0.5 + vRig * 4.0);
                const vx = bx + nx * d, vy = by + ny * d, vz = bz + nz * d;
                // Shape memory pulls every vertex back toward its rest radius —
                // this is what keeps the wobble from running away.
                let totalForce = (-d * localTension) + globalPressure - d * shapeMemory;

                // Mutual squish against nearby creatures.
                for (const lc of lcs) {
                    const dx = vx - lc.x, dy = vy - lc.y, dz = vz - lc.z;
                    const dO = Math.hypot(dx, dy, dz);
                    if (dO < lc.r && dO > 0.001) {
                        const pen = lc.r - dO;
                        const ex = dx / dO, ey = dy / dO, ez = dz / dO;
                        const dot = ex * nx + ey * ny + ez * nz;
                        let stiff = (1.2 + rg * 4.0) * (0.8 + soft * 0.9) * SOFT.collide;
                        if (pen > breakThresh) stiff *= 0.35;   // yields under heavy pressure
                        let push = dot * pen * stiff * lc.burst;
                        totalForce += Math.max(-2.6, Math.min(2.6, push));   // no lurching
                    }
                }

                // Floor contact: this vertex's world Y. Below groundY → press it
                // back inward (the bottom flattens into a rippling contact patch).
                const wy = m[1] * vx + m[5] * vy + m[9] * vz + m[13];
                if (wy < groundY) {
                    const pen = (groundY - wy) / localScale;
                    const rnWorldY = (m[1] * nx + m[5] * ny + m[9] * nz) / localScale;  // world-Y of radial dir
                    let gp = rnWorldY * pen * (1.3 + rg * 1.1);   // softer press: rnWorldY<0 on the bottom → flatten
                    totalForce += Math.max(-5, Math.min(5, gp));
                }

                sb.vel[i] = (sb.vel[i] + totalForce) * damping;
            }

            // Surface-tension wave: each vertex chases its neighbours' average.
            for (let i = 0; i < count; i++) {
                const nb = skel.neighbors[i]; let avg = 0;
                for (let j = 0; j < nb.length; j++) avg += sb.disp[nb[j]];
                if (nb.length) avg /= nb.length;
                sb.nextVel[i] = sb.vel[i] + (avg - sb.disp[i]) * waveSpeed;
            }
            for (let i = 0; i < count; i++) { sb.vel[i] = sb.nextVel[i]; sb.disp[i] += sb.vel[i]; }

            // Smooth (rim smooths more than core) so ripples read as soft jello.
            for (let i = 0; i < count; i++) {
                const nb = skel.neighbors[i]; let avg = 0;
                for (let j = 0; j < nb.length; j++) avg += sb.disp[nb[j]];
                if (nb.length) avg /= nb.length;
                // Heavier neighbour averaging: displacement spreads across the
                // surface like a fluid rather than each vertex acting alone.
                const sm = Math.min(0.99, (0.72 + rg * 0.24) * (1.0 - skel.rigid[i] * 0.35) * SOFT.smooth);
                sb.smoothed[i] = sb.disp[i] * (1 - sm) + avg * sm;
            }

            for (let i = 0; i < count; i++) {
                sb.disp[i] = sb.smoothed[i];
                // Cap indent per-vertex at 60% of the vertex's OWN radius, so no
                // vertex can travel past the centre and invert — this is what stops
                // pointed tips popping through into a jagged raindrop.
                const lim = Math.min(maxIndent, skel.baseR[i] * (0.34 + soft * 0.46));
                if (sb.disp[i] < -lim) { sb.disp[i] = -lim; sb.vel[i] *= -0.4; }
                else if (sb.disp[i] > maxOutdent) { sb.disp[i] = maxOutdent; sb.vel[i] *= -0.5; }
                const fd = sb.disp[i];
                let vx = skel.base[i * 3] + skel.rnorm[i * 3] * fd;
                let vy = skel.base[i * 3 + 1] + skel.rnorm[i * 3 + 1] * fd;
                let vz = skel.base[i * 3 + 2] + skel.rnorm[i * 3 + 2] * fd;

                // HARD FLOOR: no vertex may end up below the ground once the
                // silhouette outline's outward push is accounted for, so neither the
                // body nor its rim can ever clip through. Vertices that would sink
                // are slid up ONTO the floor, which is what flattens the contact
                // patch — the same way a neighbouring creature's membrane flattens
                // this one where they press together.
                // The lift is applied along the LOCAL direction that maps to world
                // UP, not along local +Y: a rolling body's local axes are tumbling,
                // and lifting along local +Y would send its flat spot spinning up
                // the side while the round part sank through the floor.
                const wy = m[1] * vx + m[5] * vy + m[9] * vz + m[13];
                // WORLD units: the outline's expansion happens in view space, so its
                // clearance is a world distance. Dividing by the body's scale here
                // was letting big shapes push their rim under the floor.
                const skin = SOFT.outlineSkin;
                if (wy - skin < groundY) {
                    const t = (groundY + skin - wy) / upG2;
                    vx += upGx * t; vy += upGy * t; vz += upGz * t;
                    // Is this vertex on the underside (in world terms)?
                    const facing = -(skel.rnorm[i * 3] * upGx + skel.rnorm[i * 3 + 1] * upGy
                                   + skel.rnorm[i * 3 + 2] * upGz) / localScale;
                    if (facing > 0.05) {
                        // Record the squash so pressure/tension see the contact and
                        // the membrane bulges outward around it instead of clipping.
                        const nd = (vx - skel.base[i * 3]) * skel.rnorm[i * 3]
                                 + (vy - skel.base[i * 3 + 1]) * skel.rnorm[i * 3 + 1]
                                 + (vz - skel.base[i * 3 + 2]) * skel.rnorm[i * 3 + 2];
                        if (isFinite(nd)) sb.disp[i] = Math.max(-lim, Math.min(maxOutdent, nd));
                        if (sb.vel[i] < 0) sb.vel[i] = 0;
                    }
                }
                posAttr.setXYZ(i, vx, vy, vz);
            }
            posAttr.needsUpdate = true;
            mesh.geometry.computeVertexNormals();
            // Remember the biggest outward bulge; orientFace uses it to keep the
            // emoticon just proud of the deforming surface.
            let mx = 0;
            for (let i = 0; i < count; i++) if (sb.disp[i] > mx) mx = sb.disp[i];
            sb.maxDisp = mx;
        }

        // Cheap far-away path: ease the membrane back toward its rest shape without
        // the neighbour/collision/pressure work or a normal recompute. Only touches
        // the geometry while there is still something to settle.
        function softRelax(sb) {
            const count = sb.skel.count;
            let moved = false;
            for (let i = 0; i < count; i++) {
                if (sb.disp[i] > 0.001 || sb.disp[i] < -0.001 || sb.vel[i] > 0.001 || sb.vel[i] < -0.001) { moved = true; break; }
            }
            if (!moved) return;
            const posAttr = sb.mesh.geometry.attributes.position, skel = sb.skel;
            for (let i = 0; i < count; i++) {
                sb.vel[i] *= 0.60;
                sb.disp[i] *= 0.82;
                const fd = sb.disp[i];
                posAttr.setXYZ(i,
                    skel.base[i * 3] + skel.rnorm[i * 3] * fd,
                    skel.base[i * 3 + 1] + skel.rnorm[i * 3 + 1] * fd,
                    skel.base[i * 3 + 2] + skel.rnorm[i * 3 + 2] * fd);
            }
            posAttr.needsUpdate = true;
        }

        // Continuous ground contact: eases the bottom-facing vertices inward toward
        // a flattened target while a body is resting, so it sits with a squashed
        // contact patch and a slight bulge instead of a perfect sphere.
        // Same idea as softGroundPress, but the "down" direction is given in the
        // body's LOCAL frame. A rolling ball spins its own vertices through the
        // contact patch, so pressing along a fixed local -Y would send the flat spot
        // spinning up the side (and the round part would clip into the floor). Feed
        // this the world-down vector rotated into local space and the flattening
        // stays welded to the ground, exactly like a ball of jelly rolling.
        function softGroundPressDir(sb, depth, dx, dy, dz) {
            const skel = sb.skel, count = skel.count;
            const L = Math.hypot(dx, dy, dz) || 1; dx /= L; dy /= L; dz /= L;
            for (let i = 0; i < count; i++) {
                // ny = how far this vertex faces the ground (+1 straight down)
                const ny = -(skel.rnorm[i * 3] * dx + skel.rnorm[i * 3 + 1] * dy + skel.rnorm[i * 3 + 2] * dz);
                if (ny < -0.08) {
                    const w = (-ny - 0.08) / 0.92;
                    const target = -depth * skel.maxR * w * w;
                    sb.disp[i] += (target - sb.disp[i]) * 0.30;
                } else if (ny < 0.34) {
                    // The displaced volume has to go somewhere: the waist bulges.
                    const w = 1.0 - Math.abs(ny) / 0.34;
                    const target = depth * skel.maxR * 0.62 * w;
                    sb.disp[i] += (target - sb.disp[i]) * 0.22;
                }
            }
        }
        // MITOSIS, as a membrane operation. Vertices near the axis (the poles) are
        // pushed OUT and vertices near the equator are pulled IN, so the body
        // elongates and necks at the same time — a peanut, then a dumbbell. Doing it
        // on the membrane rather than by scaling the mesh means the jelly physics
        // keeps running through the whole split, so it wobbles as it divides instead
        // of inflating like a balloon animal.
        function softPinch(sb, ax, ay, az, amount) {
            const skel = sb.skel, count = skel.count;
            const L = Math.hypot(ax, ay, az) || 1; ax /= L; ay /= L; az /= L;
            for (let i = 0; i < count; i++) {
                const dp = skel.rnorm[i * 3] * ax + skel.rnorm[i * 3 + 1] * ay + skel.rnorm[i * 3 + 2] * az;
                const along = dp * dp;                    // 1 at the poles, 0 at the equator
                const target = (along * 1.15 - (1.0 - along) * 0.80) * amount * skel.maxR;
                sb.disp[i] += (target - sb.disp[i]) * 0.34;
            }
        }
        // A slow ellipsoidal wobble along an axis — the jelly "sloshing" as it rolls.
        function softWobble(sb, ax, ay, az, amount) {
            const skel = sb.skel, count = skel.count;
            const L = Math.hypot(ax, ay, az) || 1; ax /= L; ay /= L; az /= L;
            for (let i = 0; i < count; i++) {
                const dp = skel.rnorm[i * 3] * ax + skel.rnorm[i * 3 + 1] * ay + skel.rnorm[i * 3 + 2] * az;
                sb.vel[i] += (dp * dp - 0.34) * amount * skel.maxR;
            }
        }
        function softGroundPress(sb, depth) {
            const skel = sb.skel, count = skel.count;
            for (let i = 0; i < count; i++) {
                const ny = skel.rnorm[i * 3 + 1];
                if (ny < -0.08) {
                    // Underside: flatten into the ground.
                    const w = (-ny - 0.08) / 0.92;            // 0 at the equator, 1 at the pole
                    const target = -depth * skel.maxR * w * w;
                    sb.disp[i] += (target - sb.disp[i]) * 0.25;
                } else if (ny < 0.30) {
                    // Equator: the displaced volume has to go somewhere, so the waist
                    // bulges out — that's what sells the weight of the contact.
                    const w = 1.0 - Math.abs(ny) / 0.30;
                    const target = depth * skel.maxR * 0.45 * w;
                    sb.disp[i] += (target - sb.disp[i]) * 0.18;
                }
            }
        }

        // An axial SQUASH impulse (local-space impact axis): both poles along the
        // axis pull inward, so the shape flattens along it and — driven by volume
        // pressure — bulges perpendicular, exactly like a jello hitting the floor.
        // It's a one-shot velocity pulse (scaled by impact speed at the call site),
        // so the membrane rings it out and springs back to its round rest form.
        function softImpulse(sb, ax, ay, az, amount) {
            const skel = sb.skel, count = skel.count;
            const L = Math.hypot(ax, ay, az) || 1; ax /= L; ay /= L; az /= L;
            // Softer, wider kick: half the old magnitude and spread with |dp| rather
            // than dp², so the impulse washes across the body as a swell instead of
            // slamming the two poles — that hard slam was the "snap".
            const kick = amount * skel.maxR * 0.45 * (0.7 + (1.0 - sb.rigidity) * 1.1);
            for (let i = 0; i < count; i++) {
                const dp = skel.rnorm[i * 3] * ax + skel.rnorm[i * 3 + 1] * ay + skel.rnorm[i * 3 + 2] * az;
                sb.vel[i] -= Math.abs(dp) * (0.35 + 0.65 * Math.abs(dp)) * kick;
            }
        }

    global.SoftBody = {
        params: SOFT,
        buildSoftSkeleton, makeSoftBody, softUpdate, softRelax,
        softGroundPress, softGroundPressDir, softPinch, softWobble, softImpulse
    };
})(this);
