import React, { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";

type FileItem = {
  key: string;
  oldVersionId: string;
  newVersionId: string;
  oldModified: string;
  newModified: string;
};

type SelectedDiff = {
  oldContent: string;
  newContent: string;
};

const App: React.FC = () => {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [config, setConfig] = useState<string>("");
  const [selectedDiff, setSelectedDiff] = useState<SelectedDiff | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    fetchFiles();
  }, []);

  const fetchFiles = async (): Promise<void> => {
    try {
      setLoading(true);

      const response = await fetch(
        `http://localhost:3001/api/files?ts=${Date.now()}`,
        { cache: "no-store" }
      );
      const data = await response.json();

      setFiles(data || []);
    } catch (error) {
      console.error(error);
      alert("Failed to fetch files");
    } finally {
      setLoading(false);
    }
  };

  const fetchDiff = async (file: FileItem): Promise<void> => {
    try {
      const response = await fetch(
        `http://localhost:3001/api/file-diff?key=${encodeURIComponent(
          file.key
        )}&oldVersionId=${file.oldVersionId}&newVersionId=${file.newVersionId}&ts=${Date.now()}`,
        { cache: "no-store" }
      );

      const data = await response.json();

      setSelectedDiff({
        oldContent: data.oldContent || "",
        newContent: data.newContent || ""
      });
    } catch (error) {
      console.error(error);
      alert("Failed to fetch diff");
    }
  };

  const upload = async (file: FileItem): Promise<void> => {
    try {
      const shouldUploadPreviousVersion = config.trim().length === 0;

      console.log("[UPLOAD][FRONTEND] Preparing request", {
        key: file.key,
        shouldUploadPreviousVersion,
        textLength: config.length,
        textPreview: config.slice(0, 120)
      });

      const uploadResponse = await fetch("http://localhost:3001/api/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          key: file.key,
          content: shouldUploadPreviousVersion ? undefined : config,
          oldVersionId: shouldUploadPreviousVersion ? file.oldVersionId : undefined
        })
      });

      console.log("[UPLOAD][FRONTEND] Response status", {
        key: file.key,
        status: uploadResponse.status,
        ok: uploadResponse.ok
      });

      if (!uploadResponse.ok) {
        const errorBody = await uploadResponse.json().catch(() => null);
        console.log("[UPLOAD][FRONTEND] Error body", {
          key: file.key,
          errorBody
        });
        throw new Error(errorBody?.error || "Upload request failed");
      }

      const successBody = await uploadResponse.json().catch(() => null);
      console.log("[UPLOAD][FRONTEND] Upload success", {
        key: file.key,
        successBody
      });

      alert("Uploaded successfully");
      fetchFiles();
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : "Upload failed";
      alert(`Upload failed: ${message}`);
    }
  };

  return (
    <div style={{ padding: "30px", fontFamily: "Arial" }}>
      <h1>S3 Version Diff Dashboard</h1>

      <textarea
        placeholder="Paste config to update here..."
        value={config}
        onChange={(e) => setConfig(e.target.value)}
        rows={6}
        style={{
          width: "100%",
          marginBottom: "20px",
          padding: "12px"
        }}
      />

      {loading ? (
        <p>Loading files...</p>
      ) : files.length === 0 ? (
        <p>No files found</p>
      ) : (
        files.map((file) => (
          <div
            key={file.key}
            style={{
              border: "1px solid #ddd",
              padding: "20px",
              marginBottom: "20px",
              borderRadius: "8px"
            }}
          >
            <h3>{file.key}</h3>

            <p>Old Version: {file.oldVersionId}</p>
            <p>New Version: {file.newVersionId}</p>

            <button onClick={() => fetchDiff(file)}>
              View Diff
            </button>

            <button
              onClick={() => upload(file)}
              style={{ marginLeft: "10px" }}
            >
              Upload Updated File
            </button>
          </div>
        ))
      )}

      {selectedDiff && (
        <div style={{ marginTop: "40px" }}>
          <h2>Version Diff</h2>

          <DiffEditor
            height="600px"
            language="json"
            original={selectedDiff.oldContent}
            modified={selectedDiff.newContent}
            theme="vs-dark"
            options={{
              readOnly: true,
              minimap: {
                enabled: false
              }
            }}
          />
        </div>
      )}
    </div>
  );
};

export default App;