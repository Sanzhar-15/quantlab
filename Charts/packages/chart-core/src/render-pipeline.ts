export class RenderPipeline {
  private _layers: Map<string, HTMLCanvasElement> = new Map();
  private _ctx: Map<string, CanvasRenderingContext2D> = new Map();
  private _container: HTMLElement;
  private _width: number = 0;
  private _height: number = 0;
  private _pixelRatio: number = 1;

  constructor(container: HTMLElement) {
    this._container = container;
    this._initLayers();
  }

  private _initLayers() {
    // Define explicit Z-index layers
    const layerNames = ['background', 'grid', 'underlay', 'series', 'overlay', 'ui'];
    
    layerNames.forEach((name, index) => {
      const canvas = document.createElement('canvas');
      // NEW-CH-001: Set data-layer attribute so lookup in resize() works
      canvas.setAttribute('data-layer', name);
      canvas.style.position = 'absolute';
      canvas.style.left = '0';
      canvas.style.top = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.zIndex = index.toString();
      canvas.style.pointerEvents = 'none'; // Passthrough

      this._container.appendChild(canvas);
      this._layers.set(name, canvas);
      
      const ctx = canvas.getContext('2d', { alpha: name !== 'background' });
      if (ctx) this._ctx.set(name, ctx);
    });
  }

  public resize(width: number, height: number, pixelRatio: number) {
    this._width = width;
    this._height = height;
    this._pixelRatio = pixelRatio;

    this._layers.forEach((canvas, layerName) => {
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      // NEW-CH-001: Use Map key directly instead of relying solely on data-layer attribute
      const ctx = this._ctx.get(layerName);
      if (ctx) {
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      }
    });
    
    // Note: context scaling now handled per-layer above via setTransform()
  }

  public getContext(layer: string): CanvasRenderingContext2D | undefined {
    return this._ctx.get(layer);
  }

  public clear() {
    this._ctx.forEach((ctx) => {
      ctx.clearRect(0, 0, this._width, this._height);
    });
  }
}

