import * as THREE from 'three';
import { OrbitControls } from './OrbitControls.js';
import { PlyLoader } from './PlyLoader.js';
import { SplatLoader } from './SplatLoader.js';
import { SplatBuffer } from './SplatBuffer.js';
import { LoadingSpinner } from './LoadingSpinner.js';
import { Octree } from './octree/Octree.js';
import { createSortWorker } from './worker/SortWorker.js';
import { toHalf } from './Util.js';
import { Constants } from './Constants.js';

const COVARIANCE_DATA_TEXTURE_WIDTH = 4096;
const COVARIANCE_DATA_TEXTURE_HEIGHT = 4096;

const CENTER_COLOR_DATA_TEXTURE_WIDTH = 4096;
const CENTER_COLOR_DATA_TEXTURE_HEIGHT = 4096;

const THREE_CAMERA_FOV = 60;

export class Viewer {

    constructor(params = {}) {

        if (!params.cameraUp) params.cameraUp = [0, 1, 0];
        if (!params.initialCameraPosition) params.initialCameraPosition = [0, 10, 15];
        if (!params.initialCameraLookAt) params.initialCameraLookAt = [0, 0, 0];
        if (params.selfDrivenMode === undefined) params.selfDrivenMode = true;
        if (params.useBuiltInControls === undefined) params.useBuiltInControls = true;
        params.splatAlphaRemovalThreshold = params.splatAlphaRemovalThreshold || 0;

        this.rootElement = params.rootElement;
        this.usingExternalCamera = params.camera ? true : false;
        this.usingExternalRenderer = params.renderer ? true : false;

        this.cameraUp = new THREE.Vector3().fromArray(params.cameraUp);
        this.initialCameraPosition = new THREE.Vector3().fromArray(params.initialCameraPosition);
        this.initialCameraLookAt = new THREE.Vector3().fromArray(params.initialCameraLookAt);

        this.scene = params.scene;
        this.renderer = params.renderer;
        this.camera = params.camera;
        this.useBuiltInControls = params.useBuiltInControls;
        this.controls = null;
        this.selfDrivenMode = params.selfDrivenMode;
        this.splatAlphaRemovalThreshold = params.splatAlphaRemovalThreshold;
        this.selfDrivenUpdateFunc = this.selfDrivenUpdate.bind(this);

        this.sortWorker = null;
        this.vertexRenderCount = 0;
        this.vertexSortCount = 0;

        this.inIndexArray = null;

        this.splatBuffer = null;
        this.splatMesh = null;

        this.octree = null;
        this.octreeNodeMap = {};

        this.sortRunning = false;
        this.selfDrivenModeRunning = false;
        this.splatRenderingInitialized = false;

    }

    getRenderDimensions(outDimensions) {
        if (this.rootElement) {
            outDimensions.x = this.rootElement.offsetWidth;
            outDimensions.y = this.rootElement.offsetHeight;
        } else {
            this.renderer.getSize(outDimensions);
        }
    }

    init() {

        if (!this.rootElement && !this.usingExternalRenderer) {
            this.rootElement = document.createElement('div');
            this.rootElement.style.width = '100%';
            this.rootElement.style.height = '100%';
            document.body.appendChild(this.rootElement);
        }

        const renderDimensions = new THREE.Vector2();
        this.getRenderDimensions(renderDimensions);

        if (!this.usingExternalCamera) {
            this.camera = new THREE.PerspectiveCamera(THREE_CAMERA_FOV, renderDimensions.x / renderDimensions.y, 0.1, 500);
            this.camera.position.copy(this.initialCameraPosition);
            this.camera.lookAt(this.initialCameraLookAt);
            this.camera.up.copy(this.cameraUp).normalize();
        }

        this.scene = this.scene || new THREE.Scene();

        if (!this.usingExternalRenderer) {
            this.renderer = new THREE.WebGLRenderer({
                antialias: false
            });
            this.renderer.setSize(renderDimensions.x, renderDimensions.y);
        }
        this.setupRenderTargetCopyObjects();

        if (this.useBuiltInControls) {
            this.controls = new OrbitControls(this.camera, this.renderer.domElement);
            this.controls.rotateSpeed = 0.5;
            this.controls.maxPolarAngle = (0.9 * Math.PI) / 2;
            this.controls.enableDamping = true;
            this.controls.dampingFactor = 0.15;
            this.controls.target.copy(this.initialCameraLookAt);
        }

        if (!this.usingExternalRenderer) {
            const resizeObserver = new ResizeObserver(() => {
                this.getRenderDimensions(renderDimensions);
                this.renderer.setSize(renderDimensions.x, renderDimensions.y);
            });
            resizeObserver.observe(this.rootElement);
            this.rootElement.appendChild(this.renderer.domElement);
        }

    }

    updateSplatRenderTargetForRenderDimensions(width, height) {
        this.splatRenderTarget = new THREE.WebGLRenderTarget(width, height, {
            format: THREE.RGBAFormat,
            stencilBuffer: false,
            depthBuffer: true,

        });
        this.splatRenderTarget.depthTexture = new THREE.DepthTexture(width, height);
        this.splatRenderTarget.depthTexture.format = THREE.DepthFormat;
        this.splatRenderTarget.depthTexture.type = THREE.UnsignedIntType;
    }

    setupRenderTargetCopyObjects() {
        const uniforms = {
            'sourceColorTexture': {
                'type': 't',
                'value': null
            },
            'sourceDepthTexture': {
                'type': 't',
                'value': null
            },
        };
        this.renderTargetCopyMaterial = new THREE.ShaderMaterial({
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = vec4( position.xy, 0.0, 1.0 );    
                }
            `,
            fragmentShader: `
                #include <common>
                #include <packing>
                varying vec2 vUv;
                uniform sampler2D sourceColorTexture;
                uniform sampler2D sourceDepthTexture;
                void main() {
                    vec4 color = texture2D(sourceColorTexture, vUv);
                    float fragDepth = texture2D(sourceDepthTexture, vUv).x;
                    gl_FragDepth = fragDepth;
                    gl_FragColor = color;
              }
            `,
            uniforms: uniforms,
            depthWrite: false,
            depthTest: false,
            transparent: true,
            blending: THREE.NormalBlending
        });
        this.renderTargetCopyMaterial.extensions.fragDepth = true;
        this.renderTargetCopyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.renderTargetCopyMaterial);
        this.renderTargetCopyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }

    updateSplatMeshAttributes(colors, centerCovariances, vertexCount) {

        const rgToFloat = (rg) => {
            return rg[0] + rg[1] / 65025.0;
        };

        const geometry = this.splatMesh.geometry;

        const covariances = new Float32Array(COVARIANCE_DATA_TEXTURE_WIDTH *
                                            COVARIANCE_DATA_TEXTURE_HEIGHT * 2);
        for (let c = 0; c < vertexCount; c++) {
            const centerCovarianceBase = c * 9;
            const covariancesBase = c * 6;
            covariances[covariancesBase] = centerCovariances[centerCovarianceBase + 3];
            covariances[covariancesBase + 1] = centerCovariances[centerCovarianceBase + 4];
            covariances[covariancesBase + 2] = centerCovariances[centerCovarianceBase + 5];
            covariances[covariancesBase + 3] = centerCovariances[centerCovarianceBase + 6];
            covariances[covariancesBase + 4] = centerCovariances[centerCovarianceBase + 7];
            covariances[covariancesBase + 5] = centerCovariances[centerCovarianceBase + 8];
        }
        const covarianceTexture = new THREE.DataTexture(covariances, COVARIANCE_DATA_TEXTURE_WIDTH,
                                                        COVARIANCE_DATA_TEXTURE_HEIGHT, THREE.RGFormat, THREE.FloatType);
        covarianceTexture.needsUpdate = true;
        this.splatMesh.material.uniforms.covarianceTexture.value = covarianceTexture;

        const centerColors = new Float32Array(CENTER_COLOR_DATA_TEXTURE_WIDTH * CENTER_COLOR_DATA_TEXTURE_HEIGHT * 2);
        const tempRG = [0, 0];
        for (let c = 0; c < vertexCount; c++) {
            const colorsBase = c * 4;
            const centerCovarianceBase = c * 9;
            const centerColorsBase = c * 6;
            tempRG[0] = Math.min(colors[colorsBase], 254) / 255.0;
            tempRG[1] = Math.min(colors[colorsBase + 1], 254) / 255.0;
            centerColors[centerColorsBase] = rgToFloat(tempRG);
            tempRG[0] = Math.min(colors[colorsBase + 2], 254) / 255.0;
            tempRG[1] = Math.min(colors[colorsBase + 3], 254) / 255.0;
            centerColors[centerColorsBase + 1] = rgToFloat(tempRG);

            centerColors[centerColorsBase + 2] = centerCovariances[centerCovarianceBase];
            centerColors[centerColorsBase + 3] = centerCovariances[centerCovarianceBase + 1];
            centerColors[centerColorsBase + 4] = centerCovariances[centerCovarianceBase + 2];
        }
        const centerColorTexture = new THREE.DataTexture(centerColors, CENTER_COLOR_DATA_TEXTURE_WIDTH,
                                                         CENTER_COLOR_DATA_TEXTURE_HEIGHT, THREE.RGFormat, THREE.FloatType);
        centerColorTexture.needsUpdate = true;
        this.splatMesh.material.uniforms.centerColorTexture.value = centerColorTexture;

        geometry.instanceCount = vertexCount;
    }

    updateSplatMeshIndexes(indexes, renderVertexCount) {
        const geometry = this.splatMesh.geometry;

        geometry.attributes.splatIndex.set(indexes);
        geometry.attributes.splatIndex.needsUpdate = true;

        geometry.instanceCount = renderVertexCount;
    }

    updateSplatMeshUniforms = function() {

        const renderDimensions = new THREE.Vector2();

        return function() {
            const vertexCount = this.splatBuffer.getVertexCount();
            if (vertexCount > 0) {
                this.getRenderDimensions(renderDimensions);
                this.splatMesh.material.uniforms.viewport.value.set(renderDimensions.x, renderDimensions.y);
                this.cameraFocalLength = (renderDimensions.y / 2.0) / Math.tan(this.camera.fov / 2.0 * THREE.MathUtils.DEG2RAD);
                this.splatMesh.material.uniforms.focal.value.set(this.cameraFocalLength, this.cameraFocalLength);
                this.splatMesh.material.uniformsNeedUpdate = true;
            }
        };

    }();

    loadFile(fileName) {
        const loadingSpinner = new LoadingSpinner();
        loadingSpinner.show();
        return new Promise((resolve, reject) => {
            let fileLoadPromise;
            if (fileName.endsWith('.splat')) {
                fileLoadPromise = new SplatLoader().loadFromFile(fileName);
            } else if (fileName.endsWith('.ply')) {
                fileLoadPromise = new PlyLoader().loadFromFile(fileName);
            } else {
                reject(new Error(`Viewer::loadFile -> File format not supported: ${fileName}`));
            }
            fileLoadPromise
            .then((splatBuffer) => {

                this.splatBuffer = splatBuffer;

                this.splatBuffer.optimize(this.splatAlphaRemovalThreshold);
                const vertexCount = this.splatBuffer.getVertexCount();
                console.log(`Splat count: ${vertexCount}`);

                this.splatBuffer.buildPreComputedBuffers();
                this.splatMesh = this.buildMesh(this.splatBuffer);
                this.splatMesh.frustumCulled = false;
                this.splatMesh.renderOrder = 10;
                this.updateSplatMeshUniforms();

                this.octree = new Octree(8, 5000);
                console.time('Octree build');
                this.octree.processScene(splatBuffer);
                console.timeEnd('Octree build');

                let leavesWithVertices = 0;
                let avgVertexCount = 0;
                let maxVertexCount = 0;
                let nodeCount = 0;

                this.octree.visitLeaves((node) => {
                    const vertexCount = node.data.indexes.length;
                    if (vertexCount > 0) {
                        this.octreeNodeMap[node.id] = node;
                        avgVertexCount += vertexCount;
                        maxVertexCount = Math.max(maxVertexCount, vertexCount);
                        nodeCount++;
                        leavesWithVertices++;
                    }
                });
                console.log(`Octree leaves: ${this.octree.countLeaves()}`);
                console.log(`Octree leaves with vertices:${leavesWithVertices}`);
                avgVertexCount /= nodeCount;
                console.log(`Avg vertex count per node: ${avgVertexCount}`);

                this.vertexRenderCount = vertexCount;
                loadingSpinner.hide();

                this.sortWorker = createSortWorker(vertexCount, SplatBuffer.RowSizeBytes);
                this.sortWorker.onmessage = (e) => {
                    if (e.data.sortDone) {
                        this.sortRunning = false;
                        this.updateSplatMeshIndexes(this.outIndexArray, e.data.vertexRenderCount);
                    } else if (e.data.sortCanceled) {
                        this.sortRunning = false;
                    } else if (e.data.sortSetupPhase1Complete) {
                        console.log('Sorting web worker WASM setup complete.');
                        const workerTransferPositionArray = new Float32Array(vertexCount * SplatBuffer.PositionComponentCount);
                        this.splatBuffer.fillPositionArray(workerTransferPositionArray);
                        this.sortWorker.postMessage({
                            'positions': workerTransferPositionArray.buffer
                        });
                        this.outIndexArray = new Uint32Array(e.data.outIndexBuffer,
                                                             e.data.outIndexOffset, this.splatBuffer.getVertexCount());
                        this.inIndexArray = new Uint32Array(e.data.inIndexBuffer,
                                                            e.data.inIndexOffset, this.splatBuffer.getVertexCount());
                        for (let i = 0; i < vertexCount; i++) this.inIndexArray[i] = i;
                    } else if (e.data.sortSetupComplete) {
                        console.log('Sorting web worker ready.');
                        const attributeData = this.getAttributeDataFromSplatBuffer(this.splatBuffer);
                        this.updateSplatMeshIndexes(this.outIndexArray, this.splatBuffer.getVertexCount());
                        this.updateSplatMeshAttributes(attributeData.colors,
                                                       attributeData.centerCovariances, this.splatBuffer.getVertexCount());
                        this.updateView(true, true);
                        this.splatRenderingInitialized = true;
                        resolve();
                    }
                };

            })
            .catch((e) => {
                reject(new Error(`Viewer::loadFile -> Could not load file ${fileName}`));
            });
        });
    }

    addDebugMeshesToScene() {
        this.debugRoot = this.createDebugMeshes();
        this.secondaryDebugRoot = this.createSecondaryDebugMeshes();
        this.scene.add(this.debugRoot);
        this.scene.add(this.secondaryDebugRoot);
    }

    createDebugMeshes(renderOrder) {
        const sphereGeometry = new THREE.SphereGeometry(1, 32, 32);
        const debugMeshRoot = new THREE.Object3D();

        const createMesh = (color, position) => {
            let sphereMesh = new THREE.Mesh(sphereGeometry, this.buildDebugMaterial(color));
            sphereMesh.renderOrder = renderOrder;
            debugMeshRoot.add(sphereMesh);
            sphereMesh.position.fromArray(position);
        };

        createMesh(0xff0000, [-50, 0, 0]);
        createMesh(0xff0000, [50, 0, 0]);
        createMesh(0x00ff00, [0, 0, -50]);
        createMesh(0x00ff00, [0, 0, 50]);
        createMesh(0xffaa00, [5, 0, 5]);

        return debugMeshRoot;
    }

    createSecondaryDebugMeshes(renderOrder) {
        const boxGeometry = new THREE.BoxGeometry(3, 3, 3);
        const debugMeshRoot = new THREE.Object3D();

        let boxColor = 0xBBBBBB;
        const createMesh = (position) => {
            let boxMesh = new THREE.Mesh(boxGeometry, this.buildDebugMaterial(boxColor));
            boxMesh.renderOrder = renderOrder;
            debugMeshRoot.add(boxMesh);
            boxMesh.position.fromArray(position);
        };

        let separation = 10;
        createMesh([-separation, 0, -separation]);
        createMesh([-separation, 0, separation]);
        createMesh([separation, 0, -separation]);
        createMesh([separation, 0, separation]);

        return debugMeshRoot;
    }

    buildDebugMaterial(color) {
        const vertexShaderSource = `
            #include <common>
            varying float ndcDepth;

            void main() {
                gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position.xyz, 1.0);
                ndcDepth = gl_Position.z / gl_Position.w;
                gl_Position.x = gl_Position.x / gl_Position.w;
                gl_Position.y = gl_Position.y / gl_Position.w;
                gl_Position.z = 0.0;
                gl_Position.w = 1.0;

            }
        `;

        const fragmentShaderSource = `
            #include <common>
            uniform vec3 color;
            varying float ndcDepth;
            void main() {
                gl_FragDepth = (ndcDepth + 1.0) / 2.0;
                gl_FragColor = vec4(color.rgb, 0.0);
            }
        `;

        const uniforms = {
            'color': {
                'type': 'v3',
                'value': new THREE.Color(color)
            },
        };

        const material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: vertexShaderSource,
            fragmentShader: fragmentShaderSource,
            transparent: false,
            depthTest: true,
            depthWrite: true,
            side: THREE.FrontSide
        });
        material.extensions.fragDepth = true;

        return material;
    }


    gatherSceneNodes = function() {

        const nodeRenderList = [];
        const tempVectorYZ = new THREE.Vector3();
        const tempVectorXZ = new THREE.Vector3();
        const tempVector = new THREE.Vector3();
        const tempMatrix4 = new THREE.Matrix4();
        const renderDimensions = new THREE.Vector3();
        const forward = new THREE.Vector3(0, 0, -1);

        const tempMax = new THREE.Vector3();
        const nodeSize = (node) => {
            return tempMax.copy(node.max).sub(node.min).length();
        };

        const MaximumDistanceToSort = 125;

        return function(gatherAllNodes) {

            this.getRenderDimensions(renderDimensions);
            const fovXOver2 = Math.atan(renderDimensions.x / 2.0 / this.cameraFocalLength);
            const fovYOver2 = Math.atan(renderDimensions.y / 2.0 / this.cameraFocalLength);
            const cosFovXOver2 = Math.cos(fovXOver2);
            const cosFovYOver2 = Math.cos(fovYOver2);
            tempMatrix4.copy(this.camera.matrixWorld).invert();

            let nodeRenderCount = 0;
            let verticesToCopy = 0;
            const nodeCount = this.octree.nodesWithIndexes.length;
            for (let i = 0; i < nodeCount; i++) {
                const node = this.octree.nodesWithIndexes[i];
                tempVector.copy(node.center).sub(this.camera.position);
                const distanceToNode = tempVector.length();
                tempVector.normalize();
                tempVector.transformDirection(tempMatrix4);

                tempVectorYZ.copy(tempVector).setX(0).normalize();
                tempVectorXZ.copy(tempVector).setY(0).normalize();

                const cameraAngleXZDot = forward.dot(tempVectorXZ);
                const cameraAngleYZDot = forward.dot(tempVectorYZ);

                const ns = nodeSize(node);
                const outOfFovY = cameraAngleYZDot < (cosFovYOver2 - .4);
                const outOfFovX = cameraAngleXZDot < (cosFovXOver2 - .4);
                if (!gatherAllNodes && ((outOfFovX || outOfFovY) && distanceToNode > ns)) {
                    continue;
                }
                verticesToCopy += node.data.indexes.length;
                nodeRenderList[nodeRenderCount] = node;
                node.data.distanceToNode = distanceToNode;
                nodeRenderCount++;
            }

            nodeRenderList.length = nodeRenderCount;
            nodeRenderList.sort((a, b) => {
                if (a.data.distanceToNode > b.data.distanceToNode) return 1;
                else return -1;
            });

            this.vertexRenderCount = verticesToCopy;
            this.vertexSortCount = 0;
            let currentByteOffset = 0;
            for (let i = 0; i < nodeRenderCount; i++) {
                const node = nodeRenderList[i];
                const shouldSort = node.data.distanceToNode <= MaximumDistanceToSort;
                if (shouldSort) {
                    this.vertexSortCount += node.data.indexes.length;
                }
                const windowSizeInts = node.data.indexes.length;
                let destView = new Uint32Array(this.inIndexArray.buffer, currentByteOffset, windowSizeInts);
                destView.set(node.data.indexes);
                currentByteOffset += windowSizeInts * Constants.BytesPerInt;
            }

        };

    }();

    start() {
        if (this.selfDrivenMode) {
            requestAnimationFrame(this.selfDrivenUpdateFunc);
            this.selfDrivenModeRunning = true;
        } else {
            throw new Error('Cannot start viewer unless it is in self driven mode.');
        }
    }

    fps = function() {

        let lastCalcTime = performance.now() / 1000;
        let frameCount = 0;

        return function() {
            const currentTime = performance.now() / 1000;
            const calcDelta = currentTime - lastCalcTime;
            if (calcDelta >= 1.0) {
                console.log('FPS: ' + frameCount);
                frameCount = 0;
                lastCalcTime = currentTime;
            } else {
                frameCount++;
            }
        };

    }();

    updateForRendererSizeChanges = function() {

        const lastRendererSize = new THREE.Vector2();
        const currentRendererSize = new THREE.Vector2();

        return function() {
            this.renderer.getSize(currentRendererSize);
            if (currentRendererSize.x !== lastRendererSize.x || currentRendererSize.y !== lastRendererSize.y) {
                if (!this.usingExternalCamera) {
                    this.camera.aspect = currentRendererSize.x / currentRendererSize.y;
                    this.camera.updateProjectionMatrix();
                }
                if (this.splatRenderingInitialized) {
                    this.updateSplatMeshUniforms();
                    this.updateSplatRenderTargetForRenderDimensions(currentRendererSize.x, currentRendererSize.y);
                }
                lastRendererSize.copy(currentRendererSize);
            }
        };

    }();

    selfDrivenUpdate() {
        if (this.selfDrivenMode) {
            requestAnimationFrame(this.selfDrivenUpdateFunc);
        }
        this.update();
        this.render();
    }

    update() {
        if (this.controls) {
            this.controls.update();
        }
        this.updateView();
        this.updateForRendererSizeChanges();
        // this.fps();
    }

    render() {
        this.renderer.autoClear = false;
        this.renderer.setClearColor(0.0, 0.0, 0.0, 0.0);

        // A more complex rendering sequence is required if you want to render "normal" Three.js
        // objects along with the splats
        if (this.scene.children.length > 0) {
            this.renderer.setRenderTarget(this.splatRenderTarget);
            this.renderer.clear(true, true, true);
            this.renderer.getContext().colorMask(false, false, false, false);
            this.renderer.render(this.scene, this.camera);
            this.renderer.getContext().colorMask(true, true, true, true);
            this.renderer.render(this.splatMesh, this.camera);

            this.renderer.setRenderTarget(null);
            this.renderer.clear(true, true, true);

            this.renderer.render(this.scene, this.camera);
            this.renderTargetCopyMaterial.uniforms.sourceColorTexture.value = this.splatRenderTarget.texture;
            this.renderTargetCopyMaterial.uniforms.sourceDepthTexture.value = this.splatRenderTarget.depthTexture;
            this.renderer.render(this.renderTargetCopyQuad, this.renderTargetCopyCamera);
        } else {
            this.renderer.clear(true, true, true);
            this.renderer.render(this.splatMesh, this.camera);
        }
    }

    updateView = function() {

        const tempMatrix = new THREE.Matrix4();
        const cameraPositionArray = [];
        const lastSortViewDir = new THREE.Vector3(0, 0, -1);
        const sortViewDir = new THREE.Vector3(0, 0, -1);
        const lastSortViewPos = new THREE.Vector3();
        const sortViewOffset = new THREE.Vector3();

        return function(force = false, gatherAllNodes = false) {
            if (!force) {
                sortViewDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
                let needsRefreshForRotation = false;
                let needsRefreshForPosition = false;
                if (sortViewDir.dot(lastSortViewDir) <= 0.95) needsRefreshForRotation = true;
                if (sortViewOffset.copy(this.camera.position).sub(lastSortViewPos).length() >= 1.0) needsRefreshForPosition = true;
                if (!needsRefreshForRotation && !needsRefreshForPosition) return;
            }

            tempMatrix.copy(this.camera.matrixWorld).invert();
            tempMatrix.premultiply(this.camera.projectionMatrix);
            cameraPositionArray[0] = this.camera.position.x;
            cameraPositionArray[1] = this.camera.position.y;
            cameraPositionArray[2] = this.camera.position.z;

            if (!this.sortRunning) {
                this.gatherSceneNodes(gatherAllNodes);
                this.sortRunning = true;
                this.sortWorker.postMessage({
                    sort: {
                        'view': tempMatrix.elements,
                        'cameraPosition': cameraPositionArray,
                        'vertexRenderCount': this.vertexRenderCount,
                        'vertexSortCount': this.vertexSortCount,
                        'inIndexBuffer': this.inIndexArray.buffer
                    }
                });
                lastSortViewPos.copy(this.camera.position);
                lastSortViewDir.copy(sortViewDir);
            }
        };

    }();

    buildMaterial() {

        const vertexShaderSource = `
            #include <common>
            precision highp float;

            attribute uint splatIndex;
            attribute vec4 splatColor;
            attribute mat3 splatCenterCovariance;

            uniform sampler2D covarianceTexture;
            uniform sampler2D centerColorTexture;
            uniform vec2 focal;
            uniform vec2 viewport;

            uniform vec2 covarianceTextureSize;
            uniform vec2 centerColorTextureSize;

            varying vec4 vColor;
            varying vec2 vUv;

            varying vec2 vPosition;

            const vec2 encodeMult = vec2(1.0f, 65025.0f);
            const float encodeNorm = 1.0f / 255.0f;
            vec2 floatToRG(float f) {
                vec2 color = encodeMult * f;
                color = fract(color);
                color.x -= color.y * encodeNorm;
                return color;
            }

            vec2 getDataUV(in int stride, in int offset, in vec2 dimensions) {
                vec2 samplerUV = vec2(0.0, 0.0);
                float d = float(splatIndex * uint(stride) + uint(offset)) / dimensions.x;
                samplerUV.y = float(floor(d)) / dimensions.y;
                samplerUV.x = fract(d);
                return samplerUV;
            }

            void main () {

                vec2 sampledCenterCovarianceA = texture2D(covarianceTexture, getDataUV(3, 0, covarianceTextureSize)).rg;
                vec2 sampledCenterCovarianceB = texture2D(covarianceTexture, getDataUV(3, 1, covarianceTextureSize)).rg;
                vec2 sampledCenterCovarianceC = texture2D(covarianceTexture, getDataUV(3, 2, covarianceTextureSize)).rg;
                 
                vec3 cov3D_M11_M12_M13 = vec3(sampledCenterCovarianceA.rg, sampledCenterCovarianceB.r);
                vec3 cov3D_M22_M23_M33 = vec3(sampledCenterCovarianceB.g, sampledCenterCovarianceC.rg);

                vec2 sampledCenterColorA = texture2D(centerColorTexture, getDataUV(3, 0, centerColorTextureSize)).rg;
                vec2 sampledCenterColorB = texture2D(centerColorTexture, getDataUV(3, 1, centerColorTextureSize)).rg;
                vec2 sampledCenterColorC = texture2D(centerColorTexture, getDataUV(3, 2, centerColorTextureSize)).rg;

                vec3 splatCenter = vec3(sampledCenterColorB.rg, sampledCenterColorC.r);
                vColor = vec4(floatToRG(sampledCenterColorA.r), floatToRG(sampledCenterColorA.g));

                vPosition = position.xy * 2.0;

                vec4 viewCenter = viewMatrix * vec4(splatCenter, 1.0);
                vec4 clipCenter = projectionMatrix * viewCenter;

                float bounds = 1.2 * clipCenter.w;
                if (clipCenter.z < -clipCenter.w || clipCenter.x < -bounds || clipCenter.x > bounds
                    || clipCenter.y < -bounds || clipCenter.y > bounds) {
                    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                    return;
                }

                // Compute the 2D covariance matrix from the upper-right portion of the 3D covariance matrix
                mat3 Vrk = mat3(
                    cov3D_M11_M12_M13.x, cov3D_M11_M12_M13.y, cov3D_M11_M12_M13.z,
                    cov3D_M11_M12_M13.y, cov3D_M22_M23_M33.x, cov3D_M22_M23_M33.y,
                    cov3D_M11_M12_M13.z, cov3D_M22_M23_M33.y, cov3D_M22_M23_M33.z
                );
                mat3 J = mat3(
                    focal.x / viewCenter.z, 0., -(focal.x * viewCenter.x) / (viewCenter.z * viewCenter.z),
                    0., focal.y / viewCenter.z, -(focal.y * viewCenter.y) / (viewCenter.z * viewCenter.z),
                    0., 0., 0.
                );
                mat3 W = transpose(mat3(viewMatrix));
                mat3 T = W * J;
                mat3 cov2Dm = transpose(T) * Vrk * T;
                cov2Dm[0][0] += 0.3;
                cov2Dm[1][1] += 0.3;

                // We are interested in the upper-left 2x2 portion of the projected 3D covariance matrix because
                // we only care about the X and Y values. We want the X-diagonal, cov2Dm[0][0],
                // the Y-diagonal, cov2Dm[1][1], and the correlation between the two cov2Dm[0][1]. We don't
                // need cov2Dm[1][0] because it is a symetric matrix.
                vec3 cov2Dv = vec3(cov2Dm[0][0], cov2Dm[0][1], cov2Dm[1][1]);

                vec3 ndcCenter = clipCenter.xyz / clipCenter.w;

                // We now need to solve for the eigen-values and eigen vectors of the 2D covariance matrix
                // so that we can determine the 2D basis for the splat. This is done using the method described
                // here: https://people.math.harvard.edu/~knill/teaching/math21b2004/exhibits/2dmatrices/index.html
                //
                // This is a different approach than in the original work at INRIA. In that work they compute the
                // max extents of the 2D covariance matrix in screen space to form an axis aligned bounding rectangle
                // which forms the geometry that is actually rasterized. They then use the inverse 2D covariance
                // matrix (called 'conic') to determine fragment opacity.
                float a = cov2Dv.x;
                float d = cov2Dv.z;
                float b = cov2Dv.y;
                float D = a * d - b * b;
                float trace = a + d;
                float traceOver2 = 0.5 * trace;
                float term2 = sqrt(trace * trace / 4.0 - D);
                float eigenValue1 = traceOver2 + term2;
                float eigenValue2 = traceOver2 - term2;

                const float maxSplatSize = 512.0;
                vec2 eigenVector1 = normalize(vec2(b, eigenValue1 - a));
                vec2 eigenVector2 = normalize(vec2(b, eigenValue2 - a));
                vec2 basisVector1 = eigenVector1 * min(sqrt(2.0 * eigenValue1), maxSplatSize);
                vec2 basisVector2 = eigenVector2 * min(sqrt(2.0 * eigenValue2), maxSplatSize);

                vec2 ndcOffset = vec2(vPosition.x * basisVector1 + vPosition.y * basisVector2) / viewport * 2.0;

                gl_Position = vec4(ndcCenter.xy + ndcOffset, ndcCenter.z, 1.0);

            }`;

        const fragmentShaderSource = `
            #include <common>
            precision highp float;

            uniform vec3 debugColor;

            varying vec4 vColor;
            varying vec2 vUv;

            varying vec2 vPosition;

            void main () {
                // compute the squared distance from the center of the splat to the current fragment in the
                // splat's local space.
                float A = -dot(vPosition, vPosition);
                if (A < -4.0) discard;
                vec3 color = vColor.rgb;
                A = exp(A) * vColor.a;
                gl_FragColor = vec4(A * color.rgb, A);
            }`;

        const uniforms = {
            'covarianceTexture': {
                'type': 't',
                'value': null
            },
            'centerColorTexture': {
                'type': 't',
                'value': null
            },
            'focal': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'viewport': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'debugColor': {
                'type': 'v3',
                'value': new THREE.Color()
            },
            'covarianceTextureSize': {
                'type': 'v2',
                'value': new THREE.Vector2(COVARIANCE_DATA_TEXTURE_WIDTH, COVARIANCE_DATA_TEXTURE_HEIGHT)
            },
            'centerColorTextureSize': {
                'type': 'v2',
                'value': new THREE.Vector2(CENTER_COLOR_DATA_TEXTURE_WIDTH, CENTER_COLOR_DATA_TEXTURE_HEIGHT)
            }
        };

        const material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: vertexShaderSource,
            fragmentShader: fragmentShaderSource,
            transparent: true,
            alphaTest: 1.0,
            blending: THREE.CustomBlending,
            blendEquation: THREE.AddEquation,
            blendSrc: THREE.OneMinusDstAlphaFactor,
            blendDst: THREE.OneFactor,
            blendSrcAlpha: THREE.OneMinusDstAlphaFactor,
            blendDstAlpha: THREE.OneFactor,
            depthTest: true,
            depthWrite: false,
            side: THREE.DoubleSide
        });

        return material;
    }

    buildGeomtery(splatBuffer) {

        const vertexCount = splatBuffer.getVertexCount();

        const baseGeometry = new THREE.BufferGeometry();

        const positionsArray = new Float32Array(6 * 3);
        const positions = new THREE.BufferAttribute(positionsArray, 3);
        baseGeometry.setAttribute('position', positions);
        positions.setXYZ(2, -1.0, 1.0, 0.0);
        positions.setXYZ(1, -1.0, -1.0, 0.0);
        positions.setXYZ(0, 1.0, 1.0, 0.0);
        positions.setXYZ(5, -1.0, -1.0, 0.0);
        positions.setXYZ(4, 1.0, -1.0, 0.0);
        positions.setXYZ(3, 1.0, 1.0, 0.0);
        positions.needsUpdate = true;

        const geometry = new THREE.InstancedBufferGeometry().copy(baseGeometry);

        const splatIndexArray = new Uint32Array(vertexCount);
        const splatIndexes = new THREE.InstancedBufferAttribute(splatIndexArray, 1, false);
        splatIndexes.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('splatIndex', splatIndexes);

        const splatColorsArray = new Float32Array(vertexCount * 4);
        const splatColors = new THREE.InstancedBufferAttribute(splatColorsArray, 4, false);
        splatColors.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('splatColor', splatColors);

        const splatCentersArray = new Float32Array(vertexCount * 9);
        const splatCenters = new THREE.InstancedBufferAttribute(splatCentersArray, 9, false);
        splatCenters.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('splatCenterCovariance', splatCenters);

        return geometry;
    }

    buildMesh(splatBuffer) {
        const geometry = this.buildGeomtery(splatBuffer);
        const material = this.buildMaterial();
        const mesh = new THREE.Mesh(geometry, material);
        return mesh;
    }

    getAttributeDataFromSplatBuffer(splatBuffer) {

        const vertexCount = splatBuffer.getVertexCount();

        const splatArray = new Float32Array(splatBuffer.getBufferData());
        const pCovarianceArray = new Float32Array(splatBuffer.getPrecomputedCovarianceBufferData());
        const pColorArray = new Uint8Array(splatBuffer.getPrecomputedColorBufferData());
        const color = new Uint8Array(vertexCount * 4);
        const centerCov = new Float32Array(vertexCount * 9);

        for (let i = 0; i < vertexCount; i++) {

            const centerCovBase = 9 * i;
            const pCovarianceBase = 6 * i;
            const colorBase = 4 * i;
            const pcColorBase = 4 * i;
            const splatArrayBase = SplatBuffer.RowSizeFloats * i;

            centerCov[centerCovBase] = splatArray[splatArrayBase];
            centerCov[centerCovBase + 1] = splatArray[splatArrayBase + 1];
            centerCov[centerCovBase + 2] = splatArray[splatArrayBase + 2];

            color[colorBase] = pColorArray[pcColorBase];
            color[colorBase + 1] = pColorArray[pcColorBase + 1];
            color[colorBase + 2] = pColorArray[pcColorBase + 2];
            color[colorBase + 3] = pColorArray[pcColorBase + 3];

            centerCov[centerCovBase + 3] = pCovarianceArray[pCovarianceBase];
            centerCov[centerCovBase + 4] = pCovarianceArray[pCovarianceBase + 1];
            centerCov[centerCovBase + 5] = pCovarianceArray[pCovarianceBase + 2];
            centerCov[centerCovBase + 6] = pCovarianceArray[pCovarianceBase + 3];
            centerCov[centerCovBase + 7] = pCovarianceArray[pCovarianceBase + 4];
            centerCov[centerCovBase + 8] = pCovarianceArray[pCovarianceBase + 5];
        }

        return {
            'colors': color,
            'centerCovariances': centerCov
        };

    };
}
