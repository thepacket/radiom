// Stub: replaces fldigi's FLTK-based image viewer. Exposes the same
// static methods wefax.cxx calls, but routes them to stdout NDJSON
// events (image-start / row / image-end / status) so the Node side can
// stream decoded rows to the browser unchanged from the previous
// from-scratch wrapper's wire protocol.
#pragma once

#include <string>

class wefax_pic {
public:
  // Pixel sink: `data` is one grayscale byte (0=black, 255=white) at
  // image-flat-buffer position `pos`. fldigi increments `pos` by
  // `bytes_per_pixel` per pixel (1 in B&W mode).
  static void update_rx_pic_bw(unsigned char data, int pos);

  // Color path (unused — we run B&W only). Left as a no-op so wefax.cxx
  // links if it pulls this in.
  static void update_rx_pic_col(unsigned char data, int pos) { (void)data; (void)pos; }

  // Geometry / lifecycle hooks.
  static void resize_rx_viewer(int width_img);
  static void set_rx_label(const std::string& win_label);
  static void abort_rx_viewer(void);

  // Phase-progress hooks. fldigi calls these as the decoder advances
  // through APT-start → phasing → image. We turn them into status
  // events so the UI knows where we are.
  static void skip_rx_apt(void);
  static void skip_rx_phasing(bool auto_center);
  static void update_rx_lpm(int lpm);
  static void update_auto_center(bool on);

  // Save / send hooks. fldigi expects to write a PNG file; we just emit
  // an image-end event and drop the filename on the floor.
  static void save_image(const std::string& fil_name, const std::string& extra_comments);
  static void send_image(const std::string& fil_name);

  // TX-side picture upload. RX-only build → no-op.
  static void set_tx_pic(unsigned char data, int col, int row, bool is_color) {
    (void)data; (void)col; (void)row; (void)is_color;
  }
  static void abort_tx_viewer(void) {}

  // Side-table linking & viewer-window helpers (RX-only build no-ops).
  static void setwefax_map_link(void*) {}
  static void create_both(bool /*for_tx*/) {}
  static void restart_tx_viewer() {}
  static void set_manual(bool) {}
};
