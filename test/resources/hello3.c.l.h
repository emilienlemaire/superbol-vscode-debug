/* Generated by           cobc 3.1.1.0 */
/* Generated from         /home/olegs/projects/gnucobol-debug/test/resources/hello3.cbl */
/* Generated at           Dec 16 2020 11:04:17 */
/* GnuCOBOL build date    Dec 12 2020 10:39:10 */
/* GnuCOBOL package date  Dec 08 2020 22:56:13 UTC */
/* Compile command        cobc -free -x -g -fsource-location -ftraceall -Q --coverage -A --coverage -v /home/olegs/projects/gnucobol-debug/test/resources/hello3.cbl */

/* Program local variables for 'hello3' */

/* Module initialization indicator */
static unsigned int	initialized = 0;

/* Module structure pointer */
static cob_module	*module = NULL;

/* Global variable pointer */
cob_global		*cob_glob_ptr;


/* Call parameters */
cob_field		*cob_procedure_params[1];

/* Perform frame stack */
struct cob_frame	*frame_overflow;
struct cob_frame	*frame_ptr;
struct cob_frame	frame_stack[255];


/* Data storage */
static int	b_2;	/* RETURN-CODE */
static cob_u8_t	b_8[5] __attribute__((aligned));	/* MYVAR */

/* End of local data storage */


/* Fields (local) */
static cob_field f_8	= {5, b_8, &a_2};	/* MYVAR */

/* End of fields */

