import * as THREE from "three";

export class SplatAnim {
  constructor() {
    this.referenceScene = null;
    this.referenceMesh = null;
    this.faces = null;
    this.triangles = [];
    this.orientations = [];
    this.scales = [];
    this.faceCenters = [];
    this.mixer = null;
  }

  update(deltaTime) {
    if (!this.mixer) {
      return;
    }

    this.mixer.update(deltaTime);
    this.referenceScene.updateMatrixWorld(true);

    console.time("updateMesh");
    this.updateMesh();
    console.timeEnd("updateMesh");
  }

  setReferenceScene(scene, animation) {
    if (this.referenceScene != scene) {
      this.referenceScene = scene;
      this.mixer = new THREE.AnimationMixer(this.referenceScene);

      if (animation) {
        this.mixer.clipAction(animation).play();
      }

      this.referenceMesh = this.referenceScene.getObjectByProperty(
        "isSkinnedMesh",
        true
      );

      this.faces = null;
      this.updateMesh();
    }
  }

  initSplatData(splatBuffers) {
    let maxBinding = 0;
    this.initialSplatData = splatBuffers.map((splatBuffer) => {
      const count = splatBuffer.getMaxSplatCount();
      const data = [];
      for (let i = 0; i < count; ++i) {
        const center = new THREE.Vector3();
        const scale = new THREE.Vector3();
        const rotation = new THREE.Quaternion();
        const binding = splatBuffer.getBinding(i);
        maxBinding = Math.max(maxBinding, binding);
        splatBuffer.getSplatCenter(i, center);
        splatBuffer.getSplatScaleAndRotation(i, scale, rotation);

        rotation.normalize();

        data.push({ binding, center, scale, rotation });
      }
      return data;
    });

    console.log("BINDINGS", maxBinding);
  }

  updateMesh() {
    const mesh = this.referenceMesh;
    if (!mesh) {
      return;
    }

    mesh.updateMatrixWorld(true);

    if (!this.faces) {
      const geometry = mesh.geometry;
      const indices = geometry.getIndex().array;

      const faces = [];

      for (let i = 0; i < indices.length; i += 3) {
        faces.push([indices[i + 0], indices[i + 1], indices[i + 2]]);
      }

      this.faces = faces;
    }

    console.time("updateMesh.1");
    const triangles = this.faces.map((face) => {
      return [
        mesh.getVertexPosition(face[0], new THREE.Vector3()),
        mesh.getVertexPosition(face[1], new THREE.Vector3()),
        mesh.getVertexPosition(face[2], new THREE.Vector3()),
      ];
    });
    console.timeEnd("updateMesh.1");

    const faceCenters = triangles.map((triangle) => {
      return new THREE.Vector3()
        .addVectors(triangle[0], triangle[1])
        .add(triangle[2])
        .divideScalar(triangle.length);
    });

    const orientations = triangles.map((triangle) =>
      this.createOrientationMatrix(triangle)
    );

    this.faceCenters = faceCenters;
    this.orientations = orientations.map((i) => i.orientation);
    this.quats = this.orientations
      .map((matrix) => {
        return new THREE.Matrix4().setFromMatrix3(matrix);
      })
      .map((matrix) =>
        new THREE.Quaternion().setFromRotationMatrix(matrix).normalize()
      );

    this.scales = orientations.map((i) => i.scale);
    this.scale = this.scales.reduce((a, b) => a + b, 0) / this.scales.length;
  }

  length(x) {
    const eps = 1e-20;
    return Math.sqrt(Math.max(x.dot(x), eps));
  }

  safeNormalize(x) {
    const eps = 1e-20;
    const len = this.length(x, eps);
    return len === 0 ? new THREE.Vector3() : x.clone().divideScalar(len);
  }

  createOrientationMatrix(triangle) {
    const v0 = triangle[0];
    const v1 = triangle[1];
    const v2 = triangle[2];

    const edge1 = new THREE.Vector3().copy(v1).sub(v0).normalize();
    const edge2 = new THREE.Vector3().copy(v2).sub(v0).normalize();

    const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
    const tangent = new THREE.Vector3().crossVectors(normal, edge1).normalize();
    const bitangent = new THREE.Vector3()
      .crossVectors(normal, tangent)
      .normalize()
      .multiplyScalar(-1);

    const orientation = new THREE.Matrix3().set(
      tangent.x,
      bitangent.x,
      normal.x,
      tangent.y,
      bitangent.y,
      normal.y,
      tangent.z,
      bitangent.z,
      normal.z
    );

    const s0 = new THREE.Vector3().copy(v1).sub(v0).length();
    const s1 = Math.abs(normal.dot(new THREE.Vector3().copy(v2).sub(v0)));
    const scale = (s0 + s1) / 2;

    return { orientation, scale };
  }

  applyMeshBinding(splatBuffers) {
    const center = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();

    splatBuffers.forEach((splatBuffer, i) => {
      const count = splatBuffer.getMaxSplatCount();
      for (let j = 0; j < count; ++j) {
        const data = this.initialSplatData[i][j];
        center.copy(data.center);
        scale.copy(data.scale);
        rotation.copy(data.rotation);
        this.applyBindingTransform(data.binding, center, scale, rotation);
        splatBuffer.setSplatCenter(j, center);
        splatBuffer.setSplatScaleAndRotation(j, scale, rotation);
      }
    });
  }

  applyBindingTransform(binding, position, scale, rotation) {
    if (binding >= this.faces.length) {
      position.set(0, 0, 0);
      scale.set(0, 0, 0);
      return;
    }

    position
      .applyMatrix3(this.orientations[binding])
      .multiplyScalar(this.scales[binding])
      .add(this.faceCenters[binding]);

    scale.set(
      scale.x * this.scales[binding],
      scale.y * this.scales[binding],
      scale.z * this.scales[binding]
    );

    rotation.multiply(this.quats[binding]).normalize();
  }
}
