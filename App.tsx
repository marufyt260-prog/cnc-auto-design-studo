import React, { useState, useCallback, useRef, useEffect } from 'react';
import ReactCrop, { type Crop } from 'react-image-crop';
import { ProcessIcon, DownloadIcon, CropIcon, ResetIcon, ViewsIcon } from './components/Icons';
import { editImageWithGemini } from './services/geminiService';

const App: React.FC = () => {
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [originalImageFile, setOriginalImageFile] = useState<File | null>(null);
  const [restoredImage, setRestoredImage] = useState<string | null>(null);
  
  const [autoCorrectPerspective, setAutoCorrectPerspective] = useState(true);
  const [removeObstructions, setRemoveObstructions] = useState(true);
  const [enhanceDetails, setEnhanceDetails] = useState(false);
  const [outlineCutPaths, setOutlineCutPaths] = useState(false);
  const [convertToLineArt, setConvertToLineArt] = useState(false);
  const [customCommand, setCustomCommand] = useState('');
  
  const [isLoading, setIsLoading] = useState(false);
  const [isGeneratingViews, setIsGeneratingViews] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [isCropping, setIsCropping] = useState(false);
  const [crop, setCrop] = useState<Crop>();
  const originalImageRef = useRef<HTMLImageElement>(null);

  const DraggableBox: React.FC<{ id: string; defaultLeft: number; defaultTop: number; className?: string; children: React.ReactNode }>=({ id, defaultLeft, defaultTop, className, children })=>{
    const [pos, setPos] = useState<{left:number; top:number}>({ left: defaultLeft, top: defaultTop });
    const dragging = useRef(false);
    const offset = useRef<{x:number;y:number}>({x:0,y:0});

    useEffect(()=>{
      try{
        const raw = localStorage.getItem('panel-pos-'+id);
        if(raw){ const p = JSON.parse(raw); if(typeof p?.left==='number' && typeof p?.top==='number'){ setPos({left:p.left, top:p.top}); }}
      }catch{}
    },[id]);

    useEffect(()=>{
      const onMove=(e:MouseEvent)=>{
        if(!dragging.current) return;
        setPos(prev=>({ left: Math.max(0, (e.clientX - offset.current.x)), top: Math.max(0, (e.clientY - offset.current.y)) }));
      };
      const onUp=()=>{
        if(dragging.current){ dragging.current=false; try{ localStorage.setItem('panel-pos-'+id, JSON.stringify(pos)); }catch{} }
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return ()=>{ window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    },[id, pos]);

    const onDown=(e: React.MouseEvent)=>{
      dragging.current=true;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      offset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    return (
      <div onMouseDown={onDown} style={{ position:'fixed', left: pos.left, top: pos.top, zIndex: 3005, cursor: 'move' }} className={className}>{children}</div>
    );
  };

  // Utility: downscale dataURL to max 1024 on longer side to satisfy Stability limits
  const downscaleDataUrl = async (dataUrl: string, target = 1024): Promise<{dataUrl: string, blob: Blob}> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // Fit image proportionally into a fixed 1024x1024 canvas (letterbox)
        const canvas = document.createElement('canvas');
        canvas.width = target; canvas.height = target;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve({ dataUrl, blob: new Blob() });
        // Optional: background fill light gray like server expects background processing
        ctx.fillStyle = '#e0e0e0';
        ctx.fillRect(0, 0, target, target);
        const scale = Math.min(target / img.width, target / img.height, 1);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const x = Math.floor((target - w) / 2);
        const y = Math.floor((target - h) / 2);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, x, y, w, h);
        const out = canvas.toDataURL('image/png');
        canvas.toBlob((b) => resolve({ dataUrl: out, blob: b || new Blob() }), 'image/png');
      };
      img.onerror = () => resolve({ dataUrl, blob: new Blob() });
      img.src = dataUrl;
    });
  };


  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setOriginalImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setOriginalImage(reader.result as string);
      };
      reader.readAsDataURL(file);
      setRestoredImage(null); // Clear previous result
      setIsCropping(false);
      setCrop(undefined);
    }
  };

  const handleGenerateViews = useCallback(async () => {
    if (!originalImage || !originalImageFile) {
        setError("Please upload an original image first.");
        return;
    }

    setIsGeneratingViews(true);
    setError(null);
    setIsCropping(false);

    try {
        // Ensure size safe for Stability
        const scaled = await downscaleDataUrl(originalImage, 1024);
        const base64Data = scaled.dataUrl.split(',')[1];

        const prompt = `
            You are an AI assistant skilled in 3D interpretation from 2D images.
            Based on the single image of a carved object provided by the user, generate a single composite image presented as a 2x2 grid.
            This grid must showcase the object from four distinct orthographic and perspective angles:
            1.  **Top-Left Quadrant:** A perfectly flat, top-down view.
            2.  **Top-Right Quadrant:** A perfectly flat, front-on view.
            3.  **Bottom-Left Quadrant:** A perfectly flat, side view (choose the most detailed side).
            4.  **Bottom-Right Quadrant:** A clean, 3D isometric or perspective view that clearly shows the object's form.

            **Critical Instructions:**
            - Each of the four views must be completely isolated on a uniform, solid light gray (#e0e0e0) background.
            - Add a thin black border around each of the four quadrants to clearly separate them.
            - Remove any original background, shadows, or distractions from the object in all views.
            - The final output must be a single, high-resolution image file containing this complete 2x2 grid.
        `;

        const result = await editImageWithGemini(base64Data, 'image/png', prompt, { width: 1024, height: 1024 });
        setRestoredImage(result);
        try {
          if (typeof window !== 'undefined' && window.parent) {
            window.parent.postMessage({ type: 'ai-studio-result', image: result }, '*');
          }
        } catch {}
    } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred.");
    } finally {
        setIsGeneratingViews(false);
    }
  }, [originalImage, originalImageFile]);

  const handlePrepare = useCallback(async () => {
    if (!originalImage || !originalImageFile) {
      setError("Please upload an original image first.");
      return;
    }
    
    setIsLoading(true);
    setError(null);
    setIsCropping(false);

    try {
      // Ensure size safe for Stability
      const scaled = await downscaleDataUrl(originalImage, 1024);
      const base64Data = scaled.dataUrl.split(',')[1];
      
      let prompt = '';
      if(convertToLineArt) {
        prompt = `
          You are an expert AI assistant specializing in converting images of carved wooden furniture into CNC-ready 2D line art. Your task is to process the user-provided image and transform it into a perfectly flat, clean, noise-free, black-and-white line drawing.

          Follow these critical instructions precisely:

          1.  **Geometric Correction (Orthorectification):** The user has provided an image of a 3D object. First, perform a perspective and curvature transformation to create a perfectly flat, "top-down" 2D view of the main carved design.
              ${autoCorrectPerspective ? "- **Instruction:** This feature is enabled. Vigorously apply perspective and curvature correction." : "- **Instruction:** This feature is disabled. Do not apply perspective correction."}

          2.  **Line Art Extraction:** This is the most critical step.
              - Analyze the primary carved design in the image.
              - Trace all significant contours and details to create a line drawing.
              - The output must be a pure 2D line art representation. All photographic textures, shading, lighting, and color information must be completely removed.
              - The resulting lines must be clean, smooth, and continuous. There should be absolutely no noise, stray pixels, or artifacts.

          3.  **Final Output Formatting:**
              - The lines of the design must be solid black (#000000).
              - The background must be a uniform, solid light gray (#e0e0e0). This is crucial for CNC software compatibility.
              - The final image should be high-contrast and high-resolution, suitable for direct use in CNC toolpath generation software.

          Do not perform any other enhancements like color correction or texture enhancement. The goal is a clean, CNC-friendly line drawing.
          ${customCommand ? `*   **Custom User Instruction:** "${customCommand}"` : ''}
        `;
      } else {
        prompt = `
          You are an expert AI assistant specializing in preparing images of carved wooden furniture and objects for CNC manufacturing. Your task is to process the user-provided image and transform it into a perfectly flat, clean, and high-fidelity asset ready for CNC toolpath generation.

          Follow these critical instructions precisely:

          1.  **Geometric Correction (Orthorectification):** The user has provided an image of a 3D object, likely taken from an angle. Your primary goal is to perform a perspective and curvature transformation to create a perfectly flat, "top-down" or "frontal" 2D view of the main carved design. Eliminate all lens distortion, perspective skew, and warping. The final output must look like a technical drawing or a direct scan.
              ${autoCorrectPerspective ? "- **Instruction:** This feature is enabled. Vigorously apply perspective and curvature correction." : ""}

          2.  **Smart Object Removal & In-painting:** The image may contain obstructions on top of the main design (e.g., door handles, knobs, locks, keyholes). Intelligently identify and completely remove these objects. Then, use advanced in-painting techniques to seamlessly reconstruct the underlying carved pattern. The filled-in area must blend perfectly with the original design.
              ${removeObstructions ? "- **Instruction:** This feature is enabled. Identify and remove any non-design obstructions." : ""}

          3.  **Detail & Texture Enhancement:** If the input image is blurry, noisy, or lacks fine detail, apply advanced image restoration techniques.
              ${enhanceDetails 
                  ? `- **Instruction:** This feature is enabled. Significantly enhance the sharpness, clarity, and texture of the carved details. Reconstruct fine lines and intricate patterns to be crisp and clear. The goal is to produce an 'ultra-detailed' result, as if the image were taken with a high-resolution macro lens.`
                  : `- **Instruction:** This feature is disabled. Perform standard sharpening and contrast adjustments only as needed.`
              }

          4.  **Design Isolation and Optimization:**
              *   Isolate the primary carved design from any distracting background elements.
              *   Place the cleaned design on a uniform, solid light gray (#e0e0e0) background. This is crucial for CNC software compatibility.
              *   Dramatically enhance the contrast and clarity of the design. The carved lines should be dark and distinct, and the flat surfaces should be light and clean.
              *   Sharpen all edges to be crisp and well-defined.
              
          5.  **Cut Path Visualization:** This is an important step for user visualization.
              ${outlineCutPaths 
                  ? `- **Instruction:** This feature is enabled. After all other processing is complete, overlay a thin, crisp, high-contrast red (#FF0000) line around the outermost edges of all primary carved design elements. This line should precisely trace the contours that a CNC router bit would follow. It must be a continuous, 1-2 pixel wide line and should not obscure the underlying design details.`
                  : `- **Instruction:** This feature is disabled. Do not add any outlines to the image.`
              }

          ${customCommand ? `6.  **Custom User Instruction:** "${customCommand}"` : ''}

          Execute these instructions to produce a high-resolution, CNC-ready raster image. The final result should be a clean, high-contrast, perfectly flat representation of the carved design.
        `;
      }
      
      const result = await editImageWithGemini(base64Data, 'image/png', prompt, { width: 1024, height: 1024 });
      setRestoredImage(result);
      try {
        if (typeof window !== 'undefined' && window.parent) {
          window.parent.postMessage({ type: 'ai-studio-result', image: result }, '*');
        }
      } catch {}
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred.");
    } finally {
      setIsLoading(false);
    }
  }, [originalImage, originalImageFile, customCommand, autoCorrectPerspective, removeObstructions, outlineCutPaths, enhanceDetails, convertToLineArt]);

  const handleDownload = () => {
    if (!restoredImage) return;

    const link = document.createElement('a');
    link.href = restoredImage;
    link.download = 'cnc-ready-design.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleApplyCrop = async () => {
    if (!originalImageRef.current || !crop || !crop.width || !crop.height || !originalImageFile) {
        return;
    }
    const image = originalImageRef.current;
    const canvas = document.createElement('canvas');
    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;
    
    canvas.width = Math.floor(crop.width * scaleX);
    canvas.height = Math.floor(crop.height * scaleY);
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    ctx.drawImage(
        image,
        crop.x * scaleX,
        crop.y * scaleY,
        crop.width * scaleX,
        crop.height * scaleY,
        0,
        0,
        canvas.width,
        canvas.height
    );
    
    const croppedDataUrl = canvas.toDataURL(originalImageFile.type);
    setOriginalImage(croppedDataUrl);

    const blob = await (await fetch(croppedDataUrl)).blob();
    const newFile = new File([blob], originalImageFile.name, { type: blob.type });
    setOriginalImageFile(newFile);

    setIsCropping(false);
    setCrop(undefined);
  };
  
  const handleReset = () => {
    setOriginalImage(null);
    setOriginalImageFile(null);
    setRestoredImage(null);
    setAutoCorrectPerspective(true);
    setRemoveObstructions(true);
    setEnhanceDetails(false);
    setOutlineCutPaths(false);
    setConvertToLineArt(false);
    setCustomCommand('');
    setIsLoading(false);
    setIsGeneratingViews(false);
    setError(null);
    setIsCropping(false);
    setCrop(undefined);
  };

  const handleCancelCrop = () => {
    setIsCropping(false);
    setCrop(undefined);
  };

  const handleCancelStudio = () => {
    try {
      if (typeof window !== 'undefined' && window.parent) {
        window.parent.postMessage({ type: 'ai-studio-cancel' }, '*');
      }
    } catch {}
  };

  // Initialize from parent-selected canvas image (AI Image button)
  useEffect(() => {
    function handleMessage(ev: MessageEvent) {
      const data = ev && ev.data as any;
      if (data && data.type === 'ai-studio-init-image' && typeof data.image === 'string') {
        const incoming = data.image as string;
        setOriginalImage(incoming);
        setRestoredImage(incoming);
        setIsCropping(false);
        setCrop(undefined);
        try {
          // Best-effort: create a File object so mime type is available for API calls
          const mime = incoming.startsWith('data:image/') ? incoming.split(';')[0].split(':')[1] : 'image/png';
          fetch(incoming)
            .then(r => r.blob())
            .then(blob => {
              const file = new File([blob], 'canvas-selection.png', { type: mime || blob.type });
              setOriginalImageFile(file);
            })
            .catch(() => {
              // ignore; user can still re-upload manually if needed
            });
        } catch {}
      }
      // Parent can set options before processing
      if (data && data.type === 'ai-studio-set-options') {
        try {
          if (typeof data.autoCorrectPerspective === 'boolean') setAutoCorrectPerspective(!!data.autoCorrectPerspective);
          if (typeof data.removeObstructions === 'boolean') setRemoveObstructions(!!data.removeObstructions);
          if (typeof data.enhanceDetails === 'boolean') setEnhanceDetails(!!data.enhanceDetails);
          if (typeof data.convertToLineArt === 'boolean') setConvertToLineArt(!!data.convertToLineArt);
          if (typeof data.outlineCutPaths === 'boolean') setOutlineCutPaths(!!data.outlineCutPaths);
          if (typeof data.customCommand === 'string') setCustomCommand(data.customCommand);
        } catch {}
      }
      // Parent can trigger processing with current state
      if (data && data.type === 'ai-studio-process') {
        // mode: 'prepare' | 'views'
        const mode = data.mode === 'views' ? 'views' : 'prepare';
        if (mode === 'views') {
          handleGenerateViews();
        } else {
          handlePrepare();
        }
      }
    }
    window.addEventListener('message', handleMessage);
    // Ask parent for the initial image if available
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'ai-studio-request-init-image' }, '*');
      }
    } catch {}
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const Toggle = ({ label, value, onChange }: { label: string, value: boolean, onChange: () => void }) => (
    <div className="flex justify-between items-center bg-green-50 border border-green-200 p-2 rounded-md">
      <label className="font-semibold text-slate-900 text-xs">{label}</label>
      <button
        onClick={onChange}
        className={`px-3 py-0.5 text-xs rounded-full transition-all duration-300 font-semibold border ${value
          ? 'bg-green-600 text-white border-green-600'
          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}
      >
        {value ? 'ON' : 'OFF'}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen text-white font-sans p-4 sm:p-8">
      {/* Global processing overlay when AI is working */}
      {(isLoading || isGeneratingViews) && (
        <div className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none">
          <div className="relative flex flex-col items-center gap-3">
            <div className="h-16 w-16 rounded-full border-4 border-cyan-400/30 border-t-cyan-300 animate-spin shadow-[0_0_30px_rgba(34,211,238,0.5)] bg-black/40" />
            <div className="px-4 py-1.5 rounded-full bg-black/70 text-xs font-semibold tracking-wide text-cyan-100 border border-cyan-400/40">
              {isLoading ? 'Preparing image for CNC…' : 'Generating multi-angle views…'}
            </div>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto">
        
        <main className="grid grid-cols-1 md:grid-cols-12 gap-8">
          {/* Left Panel - Controls */}
          <aside className="md:col-span-4 space-y-12 relative">
            <div className="bg-slate-900/60 backdrop-blur-sm border border-slate-700 p-5 rounded-lg md:hidden">
                <div className="flex justify-between items-center mb-4">
                  {isCropping && originalImage && (
                      <div className='flex space-x-2'>
                          <button onClick={handleApplyCrop} className='text-sm bg-cyan-600 hover:bg-cyan-500 text-white font-semibold px-4 py-1 rounded-full'>Apply</button>
                          <button onClick={handleCancelCrop} className='text-sm bg-slate-700 hover:bg-slate-600 text-slate-200 px-4 py-1 rounded-full'>Cancel</button>
                      </div>
                  )}
                </div>
                <div className="aspect-w-3 aspect-h-4 bg-black/30 rounded-lg flex items-center justify-center border-2 border-dashed border-cyan-500/30 overflow-hidden relative">
                  {originalImage && isCropping ? (
                      <ReactCrop crop={crop} onChange={c => setCrop(c)}>
                          <img ref={originalImageRef} src={originalImage} alt="Original to crop" className="object-contain" />
                      </ReactCrop>
                  ) : originalImage ? (
                    <img src={originalImage} alt="Original" className="w-full h-full object-contain" />
                  ) : (
                    <div className="text-center text-slate-300 p-4">
                      <p>Upload Furniture Image</p>
                      <input type="file" id="imageUpload" accept="image/*" className="hidden" onChange={handleImageUpload} />
                       <label htmlFor="imageUpload" className="mt-2 cursor-pointer text-cyan-400 hover:text-cyan-300 font-semibold">
                        Choose File
                      </label>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 mt-4">
                  <button onClick={() => setIsCropping(true)} disabled={!originalImage || isLoading || isGeneratingViews || isCropping} className="w-full flex items-center justify-center bg-slate-800/50 border border-slate-600 text-slate-300 font-bold py-2 px-4 rounded-lg hover:bg-slate-700/70 transition disabled:opacity-50 disabled:cursor-not-allowed text-sm"><CropIcon />Crop</button>
                  <button onClick={handleReset} disabled={isLoading || isGeneratingViews} className="w-full flex items-center justify-center bg-slate-800/50 border border-slate-600 text-slate-300 font-bold py-2 px-4 rounded-lg hover:bg-slate-700/70 transition disabled:opacity-50 disabled:cursor-not-allowed text-sm"><ResetIcon />Reset</button>
                </div>
            </div>
            
            <DraggableBox id="ai-settings" defaultLeft={140} defaultTop={140}>
            <div className="bg-white/95 border border-slate-300 shadow-md py-1.5 px-1 rounded-lg space-y-1.5 w-[110px] md:w-[120px] lg:w-[130px]">
              <h3 className="font-semibold text-[10px] text-slate-900 text-center mb-0.5">AI Settings</h3>
              <Toggle label="Perspective" value={autoCorrectPerspective} onChange={() => setAutoCorrectPerspective(!autoCorrectPerspective)} />
              <Toggle label="Remove Obst." value={removeObstructions} onChange={() => setRemoveObstructions(!removeObstructions)} />
              <Toggle label="Detail+" value={enhanceDetails} onChange={() => setEnhanceDetails(!enhanceDetails)} />
              <Toggle label="Line Art" value={convertToLineArt} onChange={() => setConvertToLineArt(!convertToLineArt)} />
              <Toggle label="Cut Paths" value={outlineCutPaths} onChange={() => setOutlineCutPaths(!outlineCutPaths)} />
            </div>
            </DraggableBox>
            
            {/* Custom Command moved to right panel */}

            <DraggableBox id="generate" defaultLeft={24} defaultTop={window.innerHeight ? window.innerHeight - 180 : 520}>
            <div className="space-y-1.5 w-[140px] md:w-[155px] lg:w-[170px]">
              <h3 className="font-semibold text-[11px] text-slate-300 text-center mb-1.5 pb-0.5 border-b border-cyan-500/50">3. Generate</h3>
               <button onClick={handlePrepare} disabled={isLoading || isGeneratingViews || !originalImage} className="w-full flex items-center justify-center bg-gradient-to-r from-fuchsia-500 to-cyan-500 text-white font-semibold py-1.5 px-2.5 rounded-md hover:from-fuchsia-600 hover:to-cyan-600 transition disabled:opacity-50 disabled:cursor-not-allowed text-[11px]"><ProcessIcon />{isLoading ? 'Preparing...' : 'Prepare for CNC'}</button>
                <button onClick={handleGenerateViews} disabled={!originalImage || isLoading || isGeneratingViews} className="w-full flex items-center justify-center bg-sky-600 text-white font-semibold py-1.5 px-2.5 rounded-md hover:bg-sky-500 transition disabled:opacity-50 disabled:cursor-not-allowed text-[11px]">
                    <ViewsIcon />
                    Multi-Angle Views
                </button>
               <button onClick={handleDownload} disabled={!restoredImage} className="w-full flex items-center justify-center bg-slate-800/50 border border-slate-600 text-slate-300 font-semibold py-1.5 px-2.5 rounded-md hover:bg-slate-700/70 transition disabled:opacity-50 disabled:cursor-not-allowed text-[11px]"><DownloadIcon />Download PNG</button>
               <button onClick={handleCancelStudio} className="w-full flex items-center justify-center bg-red-600 text-white font-semibold py-1.5 px-2.5 rounded-md hover:bg-red-500 transition text-[11px]">Cancel</button>
                {error && <p className="text-red-400 text-sm mt-2 text-center">{error}</p>}
            </div>
            </DraggableBox>
          </aside>

          {/* Right Panel - Restored Image */}
          <div className="md:col-span-8 relative">
            {/* Compact Upload panel (top-right) on md+ */}
            <DraggableBox id="upload" defaultLeft={window.innerWidth ? window.innerWidth - 260 : 900} defaultTop={360} className="hidden md:block">
            <div className="bg-white/90 border border-slate-300 rounded-md p-1.5 w-[190px] shadow-lg">
              <h2 className="text-center text-xs font-semibold text-slate-800 mb-1.5 bg-slate-100 rounded-sm py-1">Upload</h2>
              <div className="rounded-md border-2 border-green-600 bg-gradient-to-b from-green-100 to-green-200 py-2 text-center shadow-inner">
                <p className="text-slate-800 text-[11px]">Upload Image</p>
                <input type="file" id="imageUpload" accept="image/*" className="hidden" onChange={handleImageUpload} />
                <label htmlFor="imageUpload" className="mt-1 inline-block cursor-pointer bg-green-600 hover:bg-green-500 text-white font-semibold text-[11px] px-2.5 py-1 rounded-sm">Choose</label>
              </div>
              <div className="grid grid-cols-2 gap-1 mt-2">
                <button onClick={() => setIsCropping(true)} disabled={!originalImage || isLoading || isGeneratingViews || isCropping} className="w-full flex items-center justify-center bg-white border border-slate-300 text-slate-800 font-semibold py-1 px-2 rounded-md hover:bg-slate-50 transition disabled:opacity-50 disabled:cursor-not-allowed text-[11px]"><CropIcon />Crop</button>
                <button onClick={handleReset} disabled={isLoading || isGeneratingViews} className="w-full flex items-center justify-center bg-white border border-slate-300 text-slate-800 font-semibold py-1 px-2 rounded-md hover:bg-slate-50 transition disabled:opacity-50 disabled:cursor-not-allowed text-[11px]"><ResetIcon />Reset</button>
              </div>
            </div>
            </DraggableBox>
            {/* Compact Custom Command panel (bottom-right) */}
            <DraggableBox id="command" defaultLeft={window.innerWidth ? window.innerWidth - 240 : 920} defaultTop={window.innerHeight ? window.innerHeight - 220 : 520}>
            <div className="block bg-white/90 border border-slate-300 rounded-md p-1.5 w-[180px] shadow-lg">
              <label htmlFor="custom-command" className="block w-full text-center font-semibold mb-1.5 text-slate-800 text-[11px] bg-slate-100 rounded-sm py-1">Command <span className="text-slate-500 font-normal">(Opt.)</span></label>
              <textarea id="custom-command" value={customCommand} onChange={(e) => setCustomCommand(e.target.value)} rows={3} className="w-full bg-gradient-to-b from-green-100 to-green-200 border-2 border-green-600 text-slate-800 rounded-sm p-1 shadow-inner focus:ring focus:ring-green-400 focus:border-green-700 transition text-[11px] placeholder-slate-700" placeholder="e.g., isolate top floral..." />
            </div>
            </DraggableBox>
            {/* Result preview intentionally removed to use main canvas as the viewer */}
          </div>
        </main>
      </div>
    </div>
  );
};

export default App;