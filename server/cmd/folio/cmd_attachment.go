package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/airborne23/folio/server/internal/cli"
)

var attachmentCmd = &cobra.Command{
	Use:   "attachment",
	Short: "Work with attachments",
}

var attachmentDownloadCmd = &cobra.Command{
	Use:   "download <attachment-id>",
	Short: "Download an attachment to a local file",
	Long:  "Download an attachment by its ID to a local file.",
	Example: `  # Download an image attachment to the current directory
  $ folio attachment download abc123

  # Download to a specific directory
  $ folio attachment download abc123 -o /tmp/images`,
	Args: exactArgs(1),
	RunE: runAttachmentDownload,
}

// Wall-clock cap for a single download body transfer. Generous on
// purpose: the underlying HTTP client has no Timeout, so we rely on this
// to keep a truly stuck stream from hanging the agent forever, while not
// killing slow-but-progressing downloads the way a tight cap would.
const attachmentDownloadTimeout = 30 * time.Minute

func init() {
	attachmentCmd.AddCommand(attachmentDownloadCmd)

	attachmentDownloadCmd.Flags().StringP("output-dir", "o", ".", "Directory to save the downloaded file")
}

func runAttachmentDownload(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	// Metadata GET runs under a tight context — it's a small JSON call
	// and a hang here usually means a config problem worth surfacing fast.
	metaCtx, metaCancel := context.WithTimeout(cmd.Context(), 30*time.Second)
	defer metaCancel()

	var att map[string]any
	if err := client.GetJSON(metaCtx, "/api/attachments/"+args[0], &att); err != nil {
		return fmt.Errorf("get attachment: %w", err)
	}

	downloadURL := strVal(att, "download_url")
	if downloadURL == "" {
		return fmt.Errorf("attachment has no download URL")
	}

	filename := filepath.Base(strVal(att, "filename"))
	if filename == "" || filename == "." {
		filename = args[0]
	}

	outputDir, _ := cmd.Flags().GetString("output-dir")
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}
	destPath := filepath.Join(outputDir, filename)
	partPath := destPath + ".partial"

	// Stream the body straight to disk so memory cost is O(buffer), not
	// O(file size). Write to a sibling .partial then atomically rename
	// on success — the dest file never contains a half-written body if
	// the agent / network dies mid-stream.
	out, err := os.OpenFile(partPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("open output: %w", err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = out.Close()
		}
	}()

	bodyCtx, bodyCancel := context.WithTimeout(cmd.Context(), attachmentDownloadTimeout)
	defer bodyCancel()

	written, downloadErr := client.DownloadFileTo(bodyCtx, downloadURL, out)
	closeErr := out.Close()
	closed = true
	if downloadErr != nil {
		_ = os.Remove(partPath)
		return fmt.Errorf("download file: %w", downloadErr)
	}
	if closeErr != nil {
		_ = os.Remove(partPath)
		return fmt.Errorf("close output: %w", closeErr)
	}

	if err := os.Rename(partPath, destPath); err != nil {
		_ = os.Remove(partPath)
		return fmt.Errorf("finalize output: %w", err)
	}

	abs, err := filepath.Abs(destPath)
	if err != nil {
		abs = destPath
	}
	fmt.Fprintln(os.Stderr, "Downloaded:", abs)

	return cli.PrintJSON(os.Stdout, map[string]any{
		"id":         strVal(att, "id"),
		"filename":   filename,
		"path":       abs,
		"size":       strVal(att, "size_bytes"),
		"bytes_read": written,
	})
}
