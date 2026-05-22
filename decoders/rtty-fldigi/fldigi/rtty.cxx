// ----------------------------------------------------------------------------
// rtty.cxx  --  RTTY modem
//
// Copyright (C) 2012
//		Dave Freese, W1HKJ
//		Stefan Fendt, DL1SMF
//
// This file is part of fldigi.
//
// This code bears some resemblance to code contained in gmfsk from which
// it originated.  Much has been changed, but credit should still be
// given to Tomi Manninen (oh2bns@sral.fi), who so graciously distributed
// his gmfsk modem under the GPL.
//
// Fldigi is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Fldigi is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with fldigi.  If not, see <http://www.gnu.org/licenses/>.
// ----------------------------------------------------------------------------

#include <config.h>
#include <iostream>
#include <fstream>

#include "view_rtty.h"
#include "fl_digi.h"
#include "digiscope.h"
#include "misc.h"
#include "waterfall.h"
#include "confdialog.h"
#include "configuration.h"
#include "status.h"
#include "digiscope.h"
#include "trx.h"
#include "debug.h"
#include "synop.h"
#include "main.h"
#include "modem.h"

#include "threads.h"

#include "rtty.h"

#include "fsk.h"

#define FILTER_DEBUG 0

#define SHAPER_BAUD 150

//=====================================================================
// Baudot support
//=====================================================================

static char letters[32] = {
	'\0',	'E',	'\n',	'A',	' ',	'S',	'I',	'U',
	'\r',	'D',	'R',	'J',	'N',	'F',	'C',	'K',
	'T',	'Z',	'L',	'W',	'H',	'Y',	'P',	'Q',
	'O',	'B',	'G',	' ',	'M',	'X',	'V',	' '
};

/*
 * U.S. version of the figures case.
 */
static char figures[32] = {
	'\0',	'3',	'\n',	'-',	' ',	'\a',	'8',	'7',
	'\r',	'$',	'4',	'\'',	',',	'!',	':',	'(',
	'5',	'"',	')',	'2',	'#',	'6',	'0',	'1',
	'9',	'?',	'&',	' ',	'.',	'/',	';',	' '
};

int dspcnt = 0;

static char msg1[20];

const double	rtty::SHIFT[] = {23, 85, 160, 170, 182, 200, 240, 350, 425, 850};
// FILTLEN must be same size as BAUD
const double	rtty::BAUD[]  = {45, 45.45, 50, 56, 75, 100, 110, 150, 200, 300};
const int		rtty::FILTLEN[] = { 512, 512, 512, 512, 512, 512, 512, 256, 128, 64};
const int		rtty::BITS[]  = {5, 7, 8};
const int		rtty::numshifts = (int)(sizeof(SHIFT) / sizeof(*SHIFT));
const int		rtty::numbauds = (int)(sizeof(BAUD) / sizeof(*BAUD));

void rtty::tx_init()
{
	phaseacc = 0;
	preamble = true;
	videoText();

	symbols = 0;
	acc_symbols = 0;
	ovhd_symbols = 0;

}

// Customizes output of Synop decoded data.
struct rtty_callback : public synop_callback {
	// Callback for writing decoded synop messages.
	void print(const char * str, size_t nb, bool bold ) const {
		// Could choose: FTextBase::CTRL,XMIT,RECV
		int style = bold ? FTextBase::XMIT : FTextBase::RECV;
		for( size_t i = 0; i < nb; ++i ) {
			unsigned char c = str[i];
			put_rx_char(progdefaults.rx_lowercase ? tolower(c) : c, style );
		}
	}
	// Should we log new Synop messages to the current Adif log file ?
	bool log_adif(void) const { return progdefaults.SynopAdifDecoding ;}
	// Should we log new Synop messages to KML file ?
	bool log_kml(void) const { return progdefaults.SynopKmlDecoding ;}

	bool interleaved(void) const { return progdefaults.SynopInterleaved ;}
};

void rtty::rx_init()
{
	rxstate = RTTY_RX_STATE_IDLE;
	rxmode = LETTERS;
	phaseacc = 0;
	FSKphaseacc = 0;

	for (int i = 0; i < MAXBITS; i++ ) bit_buf[i] = 0.0;

	mark_phase = 0;
	space_phase = 0;
	xy_phase = 0.0;

	mark_mag = 0;
	space_mag = 0;
	mark_env = 0;
	space_env = 0;

	inp_ptr = 0;

	lastchar = 0;

	// Synop file is reloaded each time we enter this modem. Ideally do that when the file is changed.
	static bool wmo_loaded = false ;
	if( wmo_loaded == false ) {
		wmo_loaded = true ;
		SynopDB::Init(PKGDATADIR);
	}
	/// Used by weather reports decoding.
	synop::setup<rtty_callback>();
	synop::instance()->init();
}

void rtty::init()
{
	bool wfrev = wf->Reverse();
	bool wfsb = wf->USB();
	// Probably not necessary because similar to modem::set_reverse
	reverse = wfrev ^ !wfsb;
	stopflag = false;

	if (progdefaults.StartAtSweetSpot)
		set_freq(progdefaults.RTTYsweetspot);
	else if (progStatus.carrier != 0) {
		set_freq(progStatus.carrier);
#if !BENCHMARK_MODE
		progStatus.carrier = 0;
#endif
	} else
		set_freq(wf->Carrier());

	rx_init();
	put_MODEstatus(mode);
	if ((rtty_baud - (int)rtty_baud) == 0)
		snprintf(msg1, sizeof(msg1), "%-3.0f/%-4.0f", rtty_baud, rtty_shift);
	else
		snprintf(msg1, sizeof(msg1), "%-4.2f/%-4.0f", rtty_baud, rtty_shift);
	put_Status1(msg1);
	if (progdefaults.PreferXhairScope)
		set_scope_mode(Digiscope::XHAIRS);
	else
		set_scope_mode(Digiscope::RTTY);
	for (int i = 0; i < MAXPIPE; i++) mark_history[i] = space_history[i] = cmplx(0,0);

	lastchar = 0;
}

rtty::~rtty()
{
	if (rttyviewer) delete rttyviewer;

	if (mark_filt) delete mark_filt;
	if (space_filt) delete space_filt;
	if (pipe) delete [] pipe;
	if (dsppipe) delete [] dsppipe;
	if (bits) delete bits;
	delete m_Osc1;
	delete m_Osc2;
	delete m_SymShaper1;
	delete m_SymShaper2;

	if (fsk_tty) {
		delete fsk_tty;
		fsk_tty = 0;
	}
}

void rtty::reset_filters()
{
	delete mark_filt;
	mark_filt = new fftfilt(rtty_baud/samplerate, filter_length);
	mark_filt->rtty_filter(rtty_baud/samplerate);
	delete space_filt;
	space_filt = new fftfilt(rtty_baud/samplerate, filter_length);
	space_filt->rtty_filter(rtty_baud/samplerate);
}

void rtty::restart()
{
	double stl;

	rtty_shift = shift = (progdefaults.rtty_shift < numshifts ?
				  SHIFT[progdefaults.rtty_shift] : progdefaults.rtty_custom_shift);
	if (progdefaults.rtty_baud > numbauds - 1) progdefaults.rtty_baud = numbauds - 1;
	rtty_baud = BAUD[progdefaults.rtty_baud];
	filter_length = FILTLEN[progdefaults.rtty_baud];

	nbits = rtty_bits = BITS[progdefaults.rtty_bits];
	if (rtty_bits == 5)
		rtty_parity = RTTY_PARITY_NONE;
	else
		switch (progdefaults.rtty_parity) {
			case 0 : rtty_parity = RTTY_PARITY_NONE; break;
			case 1 : rtty_parity = RTTY_PARITY_EVEN; break;
			case 2 : rtty_parity = RTTY_PARITY_ODD; break;
			case 3 : rtty_parity = RTTY_PARITY_ZERO; break;
			case 4 : rtty_parity = RTTY_PARITY_ONE; break;
			default : rtty_parity = RTTY_PARITY_NONE; break;
		}

	shift_state = LETTERS;
	rxmode = LETTERS;
	symbollen = (int) (samplerate / rtty_baud + 0.5);

	set_bandwidth(shift);

	rtty_BW = progdefaults.RTTY_BW = rtty_baud * 2;

	wf->redraw_marker();

	reset_filters();

	if (bits)
		bits->setLength(symbollen / 8);//2);
	else
		bits = new Cmovavg(symbollen / 8);//2);
	mark_noise = space_noise = 0;
	bit = nubit = true;

// stop length = 1, 1.5 or 2 bits
	rtty_stop = progdefaults.rtty_stop;
	if (rtty_stop == 0) stl = 1.0;
	else if (rtty_stop == 1) stl = 1.5;
	else stl = 2.0;
	stoplen = (int) (stl * samplerate / rtty_baud + 0.5);
	freqerr = 0.0;
	pipeptr = 0;

	for (int i = 0; i < MAXBITS; i++ ) bit_buf[i] = 0.0;

	metric = 0.0;

	if ((rtty_baud - (int)rtty_baud) == 0)
		snprintf(msg1, sizeof(msg1), "%-3.0f/%-4.0f", rtty_baud, rtty_shift);
	else
		snprintf(msg1, sizeof(msg1), "%-4.2f/%-4.0f", rtty_baud, rtty_shift);
	put_Status1(msg1);
	put_MODEstatus(mode);
	for (int i = 0; i < MAXPIPE; i++)
		QI[i] = cmplx(0.0, 0.0);
	sigpwr = 0.0;
	noisepwr = 0.0;
	sigsearch = 0;
	dspcnt = 2*(nbits + 2);

	clear_zdata = true;

	// restart symbol-rtty_shaper
	m_SymShaper1->Preset(rtty_baud, samplerate);
	m_SymShaper2->Preset(rtty_baud, samplerate);

	mark_phase = 0;
	space_phase = 0;
	xy_phase = 0.0;

	mark_mag = 0;
	space_mag = 0;
	mark_env = 0;
	space_env = 0;

	inp_ptr = 0;

	for (int i = 0; i < MAXPIPE; i++) mark_history[i] = space_history[i] = cmplx(0,0);

	if (rttyviewer) rttyviewer->restart();

	progStatus.rtty_filter_changed = false;

}

void rtty::resetFSK() {
	delete fsk_tty;
	fsk_tty = 0;

	if (progdefaults.useFSK) {
		fsk_tty = new FSK;
		if (progdefaults.fsk_shares_port) {
			fsk_tty->fsk_shares_port(&rigio);
		} else if (!progdefaults.fsk_port.empty()) {
			fsk_tty->open_port(progdefaults.fsk_port);
		}
		fsk_tty->shift_on_space(progdefaults.fsk_shift_on_space);
		fsk_tty->reverse(progdefaults.fsk_reverse);
		if (progdefaults.fsk_on_dtr)
			fsk_tty->dtr(true);
		else
			fsk_tty->rts(true);
		sig_start = true;
	}
}

rtty::rtty(trx_mode tty_mode)
{
	cap |= CAP_AFC | CAP_REV;

	mode = tty_mode;

	samplerate = RTTY_SampleRate;

	mark_filt = (fftfilt *)0;
	space_filt = (fftfilt *)0;

	bits = (Cmovavg *)0;

	pipe = new double[MAXPIPE];
	dsppipe = new double [MAXPIPE];

	rttyviewer = new view_rtty(mode);

	m_Osc1 = new Oscillator( samplerate );
	m_Osc2 = new Oscillator( samplerate );

	m_SymShaper1 = new SymbolShaper( 45, samplerate );
	m_SymShaper2 = new SymbolShaper( 45, samplerate );

	fsk_tty = 0;

	resetFSK();

	restart();

}

void rtty::Update_syncscope()
{
	int j;
	for (int i = 0; i < symbollen; i++) {
		j = pipeptr - i;
		if (j < 0) j += symbollen;
		dsppipe[i] = pipe[j];
	}
	set_scope(dsppipe, symbollen, false);
}

void rtty::Clear_syncscope()
{
	set_scope(0, 0, false);
}

cmplx rtty::mixer(double &phase, double f, cmplx in)
{
	cmplx z = cmplx( cos(phase), sin(phase)) * in;

	phase -= TWOPI * f / samplerate;
	if (phase < -TWOPI) phase += TWOPI;

	return z;
}

unsigned char rtty::Bit_reverse(unsigned char in, int n)
{
	unsigned char out = 0;

	for (int i = 0; i < n; i++)
		out = (out << 1) | ((in >> i) & 1);

	return out;
}

static int rparity(int c)
{
	int w = c;
	int p = 0;
	while (w) {
		p += (w & 1);
		w >>= 1;
	}
	return p & 1;
}

int rttyparity(unsigned int c, int nbits)
{
	c &= (1 << nbits) - 1;

	switch (progdefaults.rtty_parity) {
	default:
	case rtty::RTTY_PARITY_NONE:
		return 0;

	case rtty::RTTY_PARITY_ODD:
		return rparity(c);

	case rtty::RTTY_PARITY_EVEN:
		return !rparity(c);

	case rtty::RTTY_PARITY_ZERO:
		return 0;

	case rtty::RTTY_PARITY_ONE:
		return 1;
	}
}

int rtty::decode_char()
{
	unsigned int parbit, par, data;

	parbit = (rxdata >> nbits) & 1;
	par = rttyparity(rxdata, nbits);

	if (rtty_parity != RTTY_PARITY_NONE && parbit != par)
		return 0;

	data = rxdata & ((1 << nbits) - 1);

	if (nbits == 5)
		return baudot_dec(data);

	return data;
}

bool rtty::is_mark_space( int &correction)
{
	correction = 0;
// test for rough bit position
	if (bit_buf[0] && !bit_buf[symbollen-1]) {
// test for mark/space straddle point
		for (int i = 0; i < symbollen; i++)
			correction += bit_buf[i];
		if (abs(symbollen/2 - correction) < 6) // too small & bad signals are not decoded
			return true;
	}
	return false;
}

bool rtty::is_mark()
{
	return bit_buf[symbollen / 2];
}

bool rtty::rx(bool bit) // original modified for probability test
{
	bool flag = false;
	unsigned char c = 0;
	int correction;

	for (int i = 1; i < symbollen; i++) bit_buf[i-1] = bit_buf[i];
	bit_buf[symbollen - 1] = bit;

	switch (rxstate) {
	case RTTY_RX_STATE_IDLE:
		if ( is_mark_space(correction)) {
			rxstate = RTTY_RX_STATE_START;
			counter = correction;
		}
		break;
	case RTTY_RX_STATE_START:
		if (--counter == 0) {
			if (!is_mark()) {
				rxstate = RTTY_RX_STATE_DATA;
				counter = symbollen;
				bitcntr = 0;
				rxdata = 0;
			} else {
				rxstate = RTTY_RX_STATE_IDLE;
			}
		}
		break;
	case RTTY_RX_STATE_DATA:
		if (--counter == 0) {
			rxdata |= is_mark() << bitcntr++;
			counter = symbollen;
		}
		if (bitcntr == nbits + (rtty_parity != RTTY_PARITY_NONE ? 1 : 0))
			rxstate = RTTY_RX_STATE_STOP;
		break;
	case RTTY_RX_STATE_STOP:
		if (--counter == 0) {
			if (is_mark()) {
				if ((metric >= progStatus.sldrSquelchValue && progStatus.sqlonoff) || !progStatus.sqlonoff) {
					c = decode_char();
					if( progdefaults.SynopAdifDecoding || progdefaults.SynopKmlDecoding ) {
						if (c != 0 && c != '\r')  {
							synop::instance()->add(c);
						} else {
							if( synop::instance()->enabled() )
								synop::instance()->flush(false);
							put_rx_char(c);
						}
					} else if ( c != 0 ) {
// supress <CR><CR> and <LF><LF> sequences
// these were observed during the RTTY contest 2/9/2013
						if (c == '\r' && lastchar == '\r');
						else if (c == '\n' && lastchar == '\n');
						else
							put_rx_char(progdefaults.rx_lowercase ? tolower(c) : c);
						lastchar = c;
					}
					flag = true;
				}
			}
			rxstate = RTTY_RX_STATE_IDLE;
		}
		break;
	default : break;
	}

	return flag;
}

char snrmsg[80];
void rtty::Metric()
{
	double delta = rtty_baud/8.0;
	double np = wf->powerDensity(frequency, delta) * 3000 / delta;
	double sp =
		wf->powerDensity(frequency - shift/2, delta) +
		wf->powerDensity(frequency + shift/2, delta) + 1e-10;
	double snr = 0;

	sigpwr = decayavg( sigpwr, sp, sp > sigpwr ? 2 : 8);
	noisepwr = decayavg( noisepwr, np, 16 );
	snr = 10*log10(sigpwr / noisepwr);

	snprintf(snrmsg, sizeof(snrmsg), "s/n %-3.0f dB", snr);
	put_Status2(snrmsg);
	metric = CLAMP((3000 / delta) * (sigpwr/noisepwr), 0.0, 100.0);
	display_metric(metric);
}

void rtty::searchDown()
{
	double srchfreq = frequency - shift -100;
	double minfreq = shift * 2 + 100;
	double spwrlo, spwrhi, npwr;
	while (srchfreq > minfreq) {
		spwrlo = wf->powerDensity(srchfreq - shift/2, 2*rtty_baud);
		spwrhi = wf->powerDensity(srchfreq + shift/2, 2*rtty_baud);
		npwr = wf->powerDensity(srchfreq + shift, 2*rtty_baud) + 1e-10;
		if ((spwrlo / npwr > 10.0) && (spwrhi / npwr > 10.0)) {
			frequency = srchfreq;
			set_freq(frequency);
			sigsearch = SIGSEARCH;
			break;
		}
		srchfreq -= 5.0;
	}
}

void rtty::searchUp()
{
	double srchfreq = frequency + shift +100;
	double maxfreq = IMAGE_WIDTH - shift * 2 - 100;
	double spwrhi, spwrlo, npwr;
	while (srchfreq < maxfreq) {
		spwrlo = wf->powerDensity(srchfreq - shift/2, 2*rtty_baud);
		spwrhi = wf->powerDensity(srchfreq + shift/2, 2*rtty_baud);
		npwr = wf->powerDensity(srchfreq - shift, 2*rtty_baud) + 1e-10;
		if ((spwrlo / npwr > 10.0) && (spwrhi / npwr > 10.0)) {
			frequency = srchfreq;
			set_freq(frequency);
			sigsearch = SIGSEARCH;
			break;
		}
		srchfreq += 5.0;
	}
}

#if FILTER_DEBUG == 1
int snum = 0;
int mnum = 0;
#define ook(sp) \
{ \
	value = sin(2.0*M_PI*( \
		(((sp / symbollen) % 2 == 0) ? (frequency + shift/2.0) : (frequency - shift/2.0))\
		/samplerate)*sp); \
}

std::fstream ook_signal("ook_signal.csv", std::ios::out );
#endif

int rtty::rx_process(const double *buf, int len)
{
	const double *buffer = buf;
	int length = len;
	static int showxy = symbollen;

	cmplx z, zmark, zspace, *zp_mark, *zp_space;

	int n_out = 0;
	static int bitcount = 5 * nbits * symbollen;

	if ( !progdefaults.report_when_visible ||
		 dlgViewer->visible() || progStatus.show_channels )
		if (!bHistory && rttyviewer) rttyviewer->rx_process(buf, len);

	if (progStatus.rtty_filter_changed) {
		progStatus.rtty_filter_changed = false;
		reset_filters();
	}
{
	reverse = wf->Reverse() ^ !wf->USB();
}

	Metric();
#if FILTER_DEBUG == 1
double value;
#endif
	while (length-- > 0) {

// Create analytic signal from sound card input samples

#if FILTER_DEBUG == 1
if (snum < 2 * filter_length) {
	frequency = 1000.0;
	ook(snum);
	z = cmplx(value, value);
	ook_signal << snum << "," << z.real() << ",";
//	snum++;
} else {
	z = cmplx(*buffer, *buffer);
}
#else
	z = cmplx(*buffer, *buffer);
#endif
	buffer++;

// Mix it with the audio carrier frequency to create two baseband signals
// mark and space are separated and processed independently
// lowpass Windowed Sinc - Overlap-Add convolution filters.
// The two fftfilt's are the same size and processed in sync
// therefore the mark and space filters will concurrently have the
// same size outputs available for further processing

		zmark = mixer(mark_phase, frequency + shift/2.0, z);
		mark_filt->run(zmark, &zp_mark);

		zspace = mixer(space_phase, frequency - shift/2.0, z);
		n_out = space_filt->run(zspace, &zp_space);
#if FILTER_DEBUG == 1
if (snum < 2 * filter_length) {
	ook_signal << abs(zmark) <<"\n";
	snum++;
}
#endif
		for (int i = 0; i < n_out; i++) {

			mark_mag = abs(zp_mark[i]);
			mark_env = decayavg (mark_env, mark_mag,
						(mark_mag > mark_env) ? symbollen / 4 : symbollen * 16);
			mark_noise = decayavg (mark_noise, mark_mag,
						(mark_mag < mark_noise) ? symbollen / 4 : symbollen * 48);
			space_mag = abs(zp_space[i]);
			space_env = decayavg (space_env, space_mag,
						(space_mag > space_env) ? symbollen / 4 : symbollen * 16);
			space_noise = decayavg (space_noise, space_mag,
						(space_mag < space_noise) ? symbollen / 4 : symbollen * 48);
#if FILTER_DEBUG == 1
if (mnum < 2 * filter_length)
	ook_signal << ",,," << mnum++ + filter_length / 2 << "," << mark_mag << "," << space_mag << "\n";
#endif
			noise_floor = std::min(space_noise, mark_noise);

// clipped if clipped decoder selected
			double mclipped = 0, sclipped = 0;
			mclipped = mark_mag > mark_env ? mark_env : mark_mag;
			sclipped = space_mag > space_env ? space_env : space_mag;
			if (mclipped < noise_floor) mclipped = noise_floor;
			if (sclipped < noise_floor) sclipped = noise_floor;

			switch (progdefaults.rtty_cwi) {
				case 1 : // mark only decode
					space_env = sclipped = noise_floor;
					break;
				case 2: // space only decode
					mark_env = mclipped = noise_floor;
				default : ;
			}

//			double v0, v1, v2, v3, v4, v5;
			double v3;

// no ATC
//			v0 = mark_mag - space_mag;
// Linear ATC
//			v1 = mark_mag - space_mag - 0.5 * (mark_env - space_env);
// Clipped ATC
//			v2  = (mclipped - noise_floor) - (sclipped - noise_floor) - 0.5 * (
//					(mark_env - noise_floor) - (space_env - noise_floor));
// Optimal ATC
			v3  = (mclipped - noise_floor) * (mark_env - noise_floor) -
					(sclipped - noise_floor) * (space_env - noise_floor) - 0.25 * (
					(mark_env - noise_floor) * (mark_env - noise_floor) -
					(space_env - noise_floor) * (space_env - noise_floor));
// Kahn Squarer with Linear ATC
//			v4 =  (mark_mag - noise_floor) * (mark_mag - noise_floor) -
//					(space_mag - noise_floor) * (space_mag - noise_floor) - 0.25 * (
//					(mark_env - noise_floor) * (mark_env - noise_floor) -
//					(space_env - noise_floor) * (space_env - noise_floor));
// Kahn Squarer with Clipped ATC
//			v5 =  (mclipped - noise_floor) * (mclipped - noise_floor) -
//					(sclipped - noise_floor) * (sclipped - noise_floor) - 0.25 * (
//					(mark_env - noise_floor) * (mark_env - noise_floor) -
//					(space_env - noise_floor) * (space_env - noise_floor));
//				switch (progdefaults.rtty_demodulator) {
//			switch (2) { // Optimal ATC
//			case 0: // linear ATC
//				bit = v1 > 0;
//				break;
//			case 1: // clipped ATC
//				bit = v2 > 0;
//				break;
//			case 2: // optimal ATC
				bit = v3 > 0;
//				break;
//			case 3: // Kahn linear ATC
//				bit = v4 > 0;
//				break;
//			case 4: // Kahn clipped
//				bit = v5 > 0;
//				break;
//			case 5: // No ATC
//			default :
//				bit = v0 > 0;
//			}

// XY scope signal generation

			if (progdefaults.true_scope) {
//----------------------------------------------------------------------
// "true" scope implementation------------------------------------------
//----------------------------------------------------------------------

// get the baseband-signal and...
				xy = cmplx(
						zp_mark[i].real() * cos(xy_phase) + zp_mark[i].imag() * sin(xy_phase),
						zp_space[i].real() * cos(xy_phase) + zp_space[i].imag() * sin(xy_phase) );

// if mark-tone has a higher magnitude than the space-tone,
// further reduce the scope's space-amplitude and vice versa
// this makes the scope looking a little bit nicer, too...
// aka: less noisy...
				if( abs(zp_mark[i]) > abs(zp_space[i]) ) {
// note ox x complex lib does not support xy.real(double) or xy.imag(double)
					xy = cmplx( xy.real(),
								xy.imag() * abs(zp_space[i])/abs(zp_mark[i]) );
//					xy.imag() *= abs(zp_space[i])/abs(zp_mark[i]);
				} else {
					xy = cmplx( xy.real() / ( abs(zp_space[i])/abs(zp_mark[i]) ),
								xy.imag() );
//					xy.real() /= abs(zp_space[i])/abs(zp_mark[i]);
				}

// now normalize the scope
				double const norm = 1.3*(abs(zp_mark [i]) + abs(zp_space[i]));
				xy /= norm;

			} else {
//----------------------------------------------------------------------
// "ortho" scope implementation-----------------------------------------
//----------------------------------------------------------------------
// get magnitude of the baseband-signal
				if (bit)
					xy = cmplx( mark_mag * cos(xy_phase), space_noise * sin(xy_phase) / 2.0);
				else
					xy = cmplx( mark_noise * cos(xy_phase) / 2.0, space_mag * sin(xy_phase));
// now normalize the scope
				double const norm = (mark_env + space_env);
				xy /= norm;
			}

// Rotate the scope x-y iaw frequency error.  Old scopes were not capable
// of this, but it should be very handy, so... who cares of realism anyways?
			double const rotate = 8 * TWOPI * freqerr / rtty_shift;
			xy = xy * cmplx(cos(rotate), sin(rotate));

			QI[inp_ptr] = xy;

// shift it to 128Hz(!) and not to it's original position.
// this makes it more pretty and does not remove it's other
// qualities. Reason is that this is a fraction of the used
// block-size.
			xy_phase += (TWOPI * (128.0 / samplerate));
// end XY signal generation

			mark_history[inp_ptr] = zp_mark[i];
			space_history[inp_ptr] = zp_space[i];

			inp_ptr = (inp_ptr + 1) % MAXPIPE;

			if (dspcnt && (--dspcnt % (nbits + 2) == 0)) {
				pipe[pipeptr] = bit - 0.5; //testbit - 0.5;
				pipeptr = (pipeptr + 1) % symbollen;
			}

// detect TTY signal transitions
// rx(...) returns true if valid TTY bit stream detected
// either character or idle signal
			if ( rx( reverse ? !bit : bit ) ) {
				dspcnt = symbollen * (nbits + 2);
				if (!bHighSpeed) Update_syncscope();
				clear_zdata = true;
				bitcount = 5 * nbits * symbollen;
				if (sigsearch) sigsearch--;
					int mp0 = inp_ptr - 2;
				int mp1 = mp0 + 1;
				if (mp0 < 0) mp0 += MAXPIPE;
				if (mp1 < 0) mp1 += MAXPIPE;
				double ferr = (TWOPI * samplerate / rtty_baud) *
						(!reverse ?
							arg(conj(mark_history[mp1]) * mark_history[mp0]) :
							arg(conj(space_history[mp1]) * space_history[mp0]));
				if (fabs(ferr) > rtty_baud / 2) ferr = 0;
				freqerr = decayavg ( freqerr, ferr / 8,
					progdefaults.rtty_afcspeed == 0 ? 8 :
					progdefaults.rtty_afcspeed == 1 ? 4 : 1 );
				if (progStatus.afconoff &&
					(metric > progStatus.sldrSquelchValue || !progStatus.sqlonoff))
					set_freq(frequency - freqerr);
			} else
				if (bitcount) --bitcount;
		}
		if (!bHighSpeed) {
			if (!bitcount) {
				if (clear_zdata) {
					clear_zdata = false;
					Clear_syncscope();
					for (int i = 0; i < MAXPIPE; i++)
						QI[i] = cmplx(0.0, 0.0);
				}
			}
			if (!--showxy) {
				set_zdata(QI, MAXPIPE);
				showxy = symbollen;
			}
		}
	}
	return 0;
}

//=====================================================================
// RTTY transmit
//=====================================================================
//double freq1;
double maxamp = 0;

double rtty::nco(double freq)
{
	phaseacc += TWOPI * freq / samplerate;

	if (phaseacc > TWOPI) phaseacc -= TWOPI;

	return cos(phaseacc);
}

double rtty::FSKnco()
{
	FSKphaseacc += TWOPI * 1000 / samplerate;

	if (FSKphaseacc > TWOPI) FSKphaseacc -= TWOPI;

	return sin(FSKphaseacc);

}

extern Cserial CW_KEYLINE_serial;
extern bool CW_KEYLINE_isopen;


// ── RX-only stubs ────────────────────────────────────────────────────
void rtty::send_symbol(int, int)         {}
void rtty::send_stop()                   {}
void rtty::flush_stream()                {}
void rtty::send_char(int)                {}
void rtty::send_idle()                   {}
int  rtty::rtty_sleep(double)            { return 0; }
void rtty::flrig_fsk_send(char)          {}
int  rtty::tx_process()                  { return -1; }
int  rtty::baudot_enc(unsigned char)     { return 0; }

// RX-side baudot decode (was in fldigi's TX-adjacent block).
char rtty::baudot_dec(unsigned char data)
{
	int out = 0;
	switch (data) {
	case 0x1F: rxmode = LETTERS; break;
	case 0x1B: rxmode = FIGURES; break;
	case 0x04:
		if (progdefaults.UOSrx) rxmode = LETTERS;
		out = ' ';
		break;
	default:
		out = (rxmode == LETTERS) ? letters[data] : figures[data];
		break;
	}
	return out;
}

// Oscillator / SymbolShaper are TX-side. The ctor allocates them; no-op stubs.
Oscillator::Oscillator(double sr) : m_phase(0), m_samplerate(sr) {}
SymbolShaper::SymbolShaper(double, double) : m_table_size(0), m_sinc_table(nullptr),
	m_State(false), m_Accumulator(0),
	m_Counter0(0), m_Counter1(0), m_Counter2(0),
	m_Counter3(0), m_Counter4(0), m_Counter5(0),
	m_Factor0(0), m_Factor1(0), m_Factor2(0),
	m_Factor3(0), m_Factor4(0), m_Factor5(0),
	baudrate(0), samplerate(0) {}
SymbolShaper::~SymbolShaper() {}
void SymbolShaper::Preset(double, double) {}
