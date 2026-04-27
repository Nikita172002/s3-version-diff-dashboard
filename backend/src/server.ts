import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import {
  S3Client,
  ListObjectVersionsCommand,
  GetObjectCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = Number(process.env.PORT) || 3001;

/**
 * IMPORTANT:
 * Make sure these are correctly set in backend/.env
 *
 * AWS_REGION=ap-south-1
 * BUCKET_NAME=your-actual-bucket-name
 * PUBLIC_SDK_S3_DOMAIN=https://d1jj6xo3ar94ay.cloudfront.net
 * CF_DISTRIBUTION=E1AZL9HCM1UQDL
 */

const BUCKET = process.env.BUCKET_NAME as string;
const REGION = process.env.AWS_REGION || "ap-south-1";
const PUBLIC_SDK_S3_DOMAIN =
  process.env.PUBLIC_SDK_S3_DOMAIN ||
  "https://d1jj6xo3ar94ay.cloudfront.net";
const CF_DISTRIBUTION =
  process.env.CF_DISTRIBUTION || "E1AZL9HCM1UQDL";

if (!BUCKET) {
  console.error("ERROR: BUCKET_NAME is missing in .env");
  process.exit(1);
}

console.log("AWS_REGION:", REGION);
console.log("BUCKET_NAME:", BUCKET);
console.log("PUBLIC_SDK_S3_DOMAIN:", PUBLIC_SDK_S3_DOMAIN);
console.log("CF_DISTRIBUTION:", CF_DISTRIBUTION);

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ""
  }
});

function getYesterday5PM(): Date {
  const now = new Date();
  const target = new Date(now);

  target.setDate(now.getDate() - 1);
  target.setHours(17, 0, 0, 0);

  return target;
}

async function streamToString(stream: any): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: any[] = [];

    stream.on("data", (chunk: any) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf-8"))
    );
  });
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: any[] = [];

    stream.on("data", (chunk: any) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

app.get("/api/files", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const cutoff = getYesterday5PM();

    const versions = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: BUCKET
      })
    );

    const grouped: Record<string, any[]> = {};

    (versions.Versions || []).forEach((v) => {
      if (!v.Key) return;

      if (!grouped[v.Key]) {
        grouped[v.Key] = [];
      }

      grouped[v.Key].push(v);
    });

    const result: any[] = [];

    for (const key of Object.keys(grouped)) {
      const sorted = grouped[key].sort(
        (a, b) =>
          new Date(a.LastModified!).getTime() -
          new Date(b.LastModified!).getTime()
      );

      let older = null;
      let newer = null;

      for (const v of sorted) {
        const ts = new Date(v.LastModified!);

        if (ts <= cutoff) {
          older = v;
        }

        // Keep updating so we end up with the latest version after cutoff.
        if (ts > cutoff) {
          newer = v;
        }
      }

      if (!older || !newer) continue;

      const cdnUrl = `${PUBLIC_SDK_S3_DOMAIN}/${key}`;
      const cloudfrontUrl = `https://${CF_DISTRIBUTION}.cloudfront.net/${key}`;

      result.push({
        key,
        oldVersionId: older.VersionId,
        newVersionId: newer.VersionId,
        oldModified: older.LastModified,
        newModified: newer.LastModified,
        cdnUrl,
        cloudfrontUrl
      });
    }

    res.json(result);
  } catch (error) {
    console.error("FILES API ERROR:", error);

    res.status(500).json({
      error: "Failed to fetch versions"
    });
  }
});

app.get("/api/file-diff", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const {
      key,
      oldVersionId,
      newVersionId
    } = req.query;

    const oldFile = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key as string,
        VersionId: oldVersionId as string
      })
    );

    const newFile = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key as string,
        VersionId: newVersionId as string
      })
    );

    const oldContent = await streamToString(oldFile.Body);
    const newContent = await streamToString(newFile.Body);

    res.json({
      key,
      oldContent,
      newContent,
      cdnUrl: `${PUBLIC_SDK_S3_DOMAIN}/${key}`,
      cloudfrontUrl: `https://${CF_DISTRIBUTION}.cloudfront.net/${key}`
    });
  } catch (error) {
    console.error("DIFF API ERROR:", error);

    res.status(500).json({
      error: "Failed to fetch diff"
    });
  }
});

app.post("/api/upload", async (req, res) => {
  try {
    const {
      key,
      content,
      oldVersionId
    } = req.body;

    console.log("[UPLOAD][BACKEND] Request received", {
      key,
      hasContent: typeof content === "string",
      contentLength: typeof content === "string" ? content.length : null,
      contentPreview: typeof content === "string" ? content.slice(0, 120) : null,
      oldVersionId
    });

    if (!key || typeof key !== "string") {
      return res.status(400).json({
        error: "Missing or invalid key"
      });
    }

    if (typeof content === "string") {
      console.log("[UPLOAD][BACKEND] Mode: direct content upload", {
        key,
        contentLength: content.length
      });

      const putResult = await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: content
        })
      );

      console.log("[UPLOAD][BACKEND] New version created", {
        key,
        versionId: putResult.VersionId
      });

      res.json({
        success: true,
        mode: "content",
        versionId: putResult.VersionId,
        uploadedTo: `${PUBLIC_SDK_S3_DOMAIN}/${key}`,
        cloudfrontUrl: `https://${CF_DISTRIBUTION}.cloudfront.net/${key}`
      });

      return;
    } else if (typeof oldVersionId === "string" && oldVersionId) {
      console.log("[UPLOAD][BACKEND] Mode: restore old version", {
        key,
        oldVersionId
      });

      const oldFile = await s3.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: key,
          VersionId: oldVersionId
        })
      );

      if (!oldFile.Body) {
        return res.status(500).json({
          error: "Failed to read old version body"
        });
      }

      const oldBodyBuffer = await streamToBuffer(oldFile.Body);

      const putResult = await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: oldBodyBuffer,
          ContentLength: oldBodyBuffer.length,
          ContentType: oldFile.ContentType
        })
      );

      console.log("[UPLOAD][BACKEND] New version created from old version", {
        key,
        versionId: putResult.VersionId,
        sourceVersionId: oldVersionId
      });

      res.json({
        success: true,
        mode: "oldVersionId",
        sourceVersionId: oldVersionId,
        versionId: putResult.VersionId,
        uploadedTo: `${PUBLIC_SDK_S3_DOMAIN}/${key}`,
        cloudfrontUrl: `https://${CF_DISTRIBUTION}.cloudfront.net/${key}`
      });

      return;
    } else {
      return res.status(400).json({
        error: "Provide either content or oldVersionId"
      });
    }
  } catch (error) {
    console.error("UPLOAD API ERROR:", error);

    res.status(500).json({
      error: "Upload failed"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});