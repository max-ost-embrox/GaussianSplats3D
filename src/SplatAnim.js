import * as THREE from "three";

export class SplatAnim {
  constructor() {
    this.referenceScene = null;
    this.referenceMesh = null;
    this.faces = [];
    this.triangles = [];
    this.orientations = [];
    this.scales = [];
    this.faceCenters = [];
  }

  setReferenceScene(scene) {
    if (this.referenceScene != scene) {
      this.referenceScene = scene;

      this.referenceScene.updateMatrixWorld(true);

      this.referenceMesh = this.referenceScene.getObjectByProperty(
        "isSkinnedMesh",
        true
      );

      this.updateMesh();
    }
  }

  updateMesh() {
    const mesh = this.referenceMesh;
    if (!mesh) {
      return;
    }

    mesh.updateMatrixWorld(true);

    const geometry = mesh.geometry;
    const indices = geometry.getIndex().array;

    const faces = [];

    for (let i = 0; i < indices.length; i += 3) {
      faces.push([indices[i + 0], indices[i + 1], indices[i + 2]]);
    }

    const triangles = faces.map((face) => {
      return [
        mesh.getVertexPosition(face[0], new THREE.Vector3()),
        mesh.getVertexPosition(face[1], new THREE.Vector3()),
        mesh.getVertexPosition(face[2], new THREE.Vector3()),
      ];
    });

    const faceCenters = triangles.map((triangle) => {
      return new THREE.Vector3()
        .addVectors(triangle[0], triangle[1])
        .add(triangle[2])
        .divideScalar(triangle.length);
    });

    const orientations = triangles.map((triangle) =>
      this.createOrientationMatrix(triangle)
    );

    this.faces = faces;
    this.faceCenters = faceCenters;
    this.triangles = triangles;
    this.orientations = orientations.map((i) => i.orientation);
    this.quats = orientations.map(i => new THREE.Quaternion().setFromRotationMatrix(i.orientation).normalize());
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
      .normalize();

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

  applyBindingTransform(binding, position, scale, rotation) {
    if (binding >= this.faces.length) {
      position.set(0, 0, 0);
      return;
    }

    position
      .applyMatrix3(this.orientations[binding])
      .multiplyScalar(this.scale)
      .add(this.faceCenters[binding]);

    scale.set(
      Math.exp(scale.x) * this.scales[binding].x,
      Math.exp(scale.y) * this.scales[binding].y,
      Math.exp(scale.z) * this.scales[binding].z
    );

    rotation.multiply(this.quats[binding]).normalize();
  }
}
