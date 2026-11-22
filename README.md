# Area Measure

Simple web app: take a photo of an object lying next to a ruler and it calculates the object's area.

**How it works**
1. Take a photo with the **level camera** (live preview with a spirit level from the phone's tilt sensor; the photo is taken automatically once the phone is flat), the phone's camera, or choose an image.
2. The ruler is found on a best-effort basis: a rough search for periodic tick marks (FFT over image tiles) on a reduced image, then a zoom into a full-resolution strip around it where the tick spacing is measured precisely. Tick lengths (longer every 5th/10th tick) tell 1 mm from 5 mm ticks and where the cm marks are; the handles go on cm marks and the length is filled in.
3. If Chrome's built-in AI (Gemini Nano, Prompt API with image input) is available, it names the main object and gives its approximate box (and a rough ruler location). Everything runs locally on your device.
4. The object outline is found with image analysis (background color model + edges + hole filling; the ruler itself is excluded), choosing the shape that matches the AI box or the most central large shape.
5. Area = object pixels ÷ (pixels per cm)².

You can always correct the result: drag the red line roughly onto the ruler (it zooms in there and reads the ticks), drag a handle (it snaps to the nearest tick), or type the length; drag a box around the object or tap it.

**Hosting:** plain static files (`index.html`, `app.js`, `ruler.js`, `camera.js`, `style.css`) – served by GitHub Pages, no build step.
